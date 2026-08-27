/**
 * Content script — injected into meet.google.com, app.zoom.us, teams.microsoft.com.
 * Detects when the user enters/leaves a live meeting and messages the service worker.
 * Also reads participant names on meeting end.
 */
(function () {
  "use strict";

  const PLATFORM_PATTERNS = {
    meet:  /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/,
    zoom:  /app\.zoom\.us\/wc\/\d+/,
    teams: /teams\.microsoft\.com.*\/conversations/,
  };

  function detectPlatform() {
    const url = location.href;
    for (const [p, re] of Object.entries(PLATFORM_PATTERNS)) {
      if (re.test(url)) return p;
    }
    return null;
  }

  const IN_MEETING_SELECTORS = {
    // Multiple selectors across Meet UI versions — jsname/class values change
    // with Meet deploys, so we cast a wide net. The leave-call button
    // (aria-label) is the most stable signal; jsname attrs are fallbacks.
    meet: [
      '[data-call-ended="false"]',
      'button[aria-label="Leave call"]',
      'button[aria-label="Leave"]',
      '[jsname="Nqah0"]',
      '[jsname="r4jB5"]',
      '.crqnQb',
      '[jscontroller="IY7L3d"]',
      '[data-meeting-code]',
    ].join(", "),
    zoom:  ".footer-button-base__leave-btn",
    teams: '[data-tid="hangup-button"]',
  };

  const ENDED_SELECTORS = {
    meet:  '[data-call-ended="true"], .YTbUzc, [jsname="CQylAd"].D9uPtc',
    zoom:  ".post-call-page",
    teams: ".call-end-screen",
  };

  const PARTICIPANT_SELECTORS = {
    meet:  '[data-participant-id], .KF4T6b .zWfAib',
    zoom:  ".participants-item__display-name",
    teams: '[data-tid="participant-list-item-name"]',
  };

  let platform    = null;
  let inMeeting   = false;
  let meetingTitle = "";
  let checkInterval = null;
  let _endGraceTimer = null; // prevents spurious MEETING_ENDED on Meet URL micro-navigations
  let _startCooldown = false; // blocks MEETING_STARTED for 15 s after sendEnded() so Meet's
  //   post-call DOM transition (activeEl still in tree) can't immediately re-trigger detection

  // sessionStorage outlives same-tab SPA navigations; avoids re-injecting consent.
  const VS_CONSENT_KEY = "vs_consent_sent";
  let consentSent = sessionStorage.getItem(VS_CONSENT_KEY) === "1";

  const CONSENT_MESSAGE =
    "VisualSprint is recording this meeting for notes and transcript. " +
    "Let the host know if you'd like this paused.";

  // ── Safe message send ────────────────────────────────────────────────────────
  // Wraps chrome.runtime.sendMessage so a stale content-script context (after an
  // extension reload) stops the polling interval rather than throwing.
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (e?.message?.includes("Extension context invalidated")) {
        _teardown();
      }
    }
  }

  function _teardown() {
    clearInterval(checkInterval);
    clearTimeout(_endGraceTimer);
  }

  // ── Consent chat injection ───────────────────────────────────────────────────
  // Best-effort: post a disclosure message in the Meet chat so other participants
  // see the recording notice. Scoped to Meet only — Zoom/Teams selectors unverified.
  // Never blocks recording. DB-level ConsentRecord is written regardless.
  async function injectConsentMessage() {
    if (platform !== "meet" || consentSent) return;
    consentSent = true;
    sessionStorage.setItem(VS_CONSENT_KEY, "1");

    // Wait for Meet's in-call UI to fully settle.
    await _sleep(2000);
    if (!_contextAlive()) return; // extension reloaded during the wait

    try {
      // Open the chat panel if not already open.
      const chatToggle = document.querySelector(
        'button[aria-label="Chat with everyone"],'
        + 'button[aria-label="Show everyone chat"],'
        + 'button[data-tooltip="Chat with everyone"],'
        + 'button[jsname="CQylAd"]'
      );
      if (chatToggle && chatToggle.getAttribute("aria-pressed") !== "true") {
        chatToggle.click();
        await _sleep(1200);
        if (!_contextAlive()) return;
      }

      // Find the chat textarea, retry once after a second.
      const inputSel =
        'textarea[aria-label="Send a message"],'
        + 'textarea[placeholder="Send a message"],'
        + 'textarea[jsname="YPqjbf"]';
      let input = document.querySelector(inputSel);
      if (!input) {
        await _sleep(1000);
        if (!_contextAlive()) return;
        input = document.querySelector(inputSel);
      }
      if (!input) throw new Error("chat input not found");

      // Set the value via React's native setter so Meet's change detection fires.
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      ).set;
      nativeSetter.call(input, CONSENT_MESSAGE);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await _sleep(200);
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
      );

      safeSend({ type: "CONSENT_INJECTED", ok: true });
    } catch (e) {
      // Non-fatal — use safeSend so a stale context doesn't produce an unhandled rejection.
      safeSend({ type: "CONSENT_INJECTED", ok: false, error: e.message });
    }
  }

  function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function _contextAlive() {
    try {
      // Accessing chrome.runtime.id throws if the context is invalidated.
      return !!chrome.runtime?.id;
    } catch {
      _teardown();
      return false;
    }
  }

  // ── Participant roster ────────────────────────────────────────────────────────
  function getParticipants() {
    if (!platform) return [];
    return Array.from(document.querySelectorAll(PARTICIPANT_SELECTORS[platform]))
      .map((el) => el.textContent.trim())
      .filter(Boolean);
  }

  // ── Meeting state machine ─────────────────────────────────────────────────────
  function checkMeetingState() {
    try {
      const p = detectPlatform();

      if (!p) {
        // URL doesn't match a meeting pattern right now.
        // Don't immediately declare MEETING_ENDED — Meet changes URL during
        // the lobby→call transition and we'd fire a false end + re-start.
        if (inMeeting && !_endGraceTimer) {
          _endGraceTimer = setTimeout(() => {
            _endGraceTimer = null;
            if (inMeeting) sendEnded();
          }, 3000); // 3-second grace — enough to survive any lobby redirect
        }
        return;
      }

      // URL is back in a meeting — cancel any pending grace-period end.
      if (_endGraceTimer) {
        clearTimeout(_endGraceTimer);
        _endGraceTimer = null;
      }
      platform = p;

      // Check for explicit end-of-call screen.
      const endedEl = document.querySelector(ENDED_SELECTORS[platform]);
      if (endedEl && inMeeting) {
        sendEnded();
        return;
      }

      // Check for entry into the live call.
      const activeEl = document.querySelector(IN_MEETING_SELECTORS[platform]);
      if (activeEl && !inMeeting && !_startCooldown) {
        inMeeting    = true;
        meetingTitle = document.title.replace(/ – Google Meet$| – Zoom$/, "").trim();
        safeSend({ type: "MEETING_STARTED", platform, url: location.href, title: meetingTitle });
        injectConsentMessage().catch(() => {}); // async, fire-and-forget, errors silenced
      }
    } catch (e) {
      if (e?.message?.includes("Extension context invalidated")) {
        _teardown();
      }
    }
  }

  function sendEnded() {
    inMeeting   = false;
    consentSent = false;
    sessionStorage.removeItem(VS_CONSENT_KEY);
    safeSend({ type: "MEETING_ENDED", platform, roster: getParticipants() });
    // 15-second cooldown so Meet's post-call DOM transition (some activeEl selectors
    // linger briefly) can't immediately re-trigger MEETING_STARTED detection.
    _startCooldown = true;
    setTimeout(() => { _startCooldown = false; }, 15_000);
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────────
  checkInterval = setInterval(checkMeetingState, 3000);
  checkMeetingState();

  // SPA navigation hooks (Zoom / Teams are full SPAs; Meet uses pushState too).
  const _origPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _origPushState(...args);
    checkMeetingState();
  };
  window.addEventListener("popstate", checkMeetingState);
})();
