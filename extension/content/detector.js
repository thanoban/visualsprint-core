/**
 * Content script — injected into meet.google.com, app.zoom.us, teams.microsoft.com.
 * Detects when the user enters/leaves a live meeting and messages the service worker.
 * Also reads participant names on meeting end.
 */
(function () {
  "use strict";

  const PLATFORM_PATTERNS = {
    meet: /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/,
    zoom: /app\.zoom\.us\/wc\/\d+/,
    teams: /teams\.microsoft\.com.*\/conversations/,
  };

  function detectPlatform() {
    const url = location.href;
    for (const [platform, re] of Object.entries(PLATFORM_PATTERNS)) {
      if (re.test(url)) return platform;
    }
    return null;
  }

  // Platform-specific selectors for "in meeting" and "meeting ended" signals
  const IN_MEETING_SELECTORS = {
    meet: '[data-call-ended="false"], [jsname="Nqah0"], .crqnQb',  // leave button area
    zoom: ".footer-button-base__leave-btn",
    teams: '[data-tid="hangup-button"]',
  };

  const ENDED_SELECTORS = {
    meet: '[data-call-ended="true"], .YTbUzc',  // end screen / "Return to home"
    zoom: ".post-call-page",
    teams: ".call-end-screen",
  };

  const PARTICIPANT_SELECTORS = {
    meet: '[data-participant-id], .KF4T6b .zWfAib',
    zoom: ".participants-item__display-name",
    teams: '[data-tid="participant-list-item-name"]',
  };

  let platform = null;
  let inMeeting = false;
  let meetingTitle = "";
  let checkInterval = null;
  // Use sessionStorage (persists across Meet's same-tab SPA URL changes) so
  // we don't re-attempt consent injection on every micro-navigation.
  const VS_CONSENT_KEY = "vs_consent_sent";
  let consentSent = sessionStorage.getItem(VS_CONSENT_KEY) === "1";

  const CONSENT_MESSAGE =
    "VisualSprint is recording this meeting for notes and transcript. " +
    "Let the host know if you'd like this paused.";

  // Best-effort in-meeting disclosure: post a chat message so participants
  // (not just the signed-in user) see the recording notice live. Scoped to
  // Meet only -- selectors for Zoom/Teams chat panels are unverified and a
  // wrong guess is worse than no attempt. This never blocks recording: the
  // DB-level ConsentRecord (backend/app/capture/consent.py) is written
  // regardless of whether this DOM injection succeeds.
  async function injectConsentMessage() {
    if (platform !== "meet" || consentSent) return;
    consentSent = true;
    sessionStorage.setItem(VS_CONSENT_KEY, "1");

    // Wait for Meet's in-call UI to fully render before probing the DOM.
    await new Promise((r) => setTimeout(r, 2000));

    try {
      // Chat toggle — Meet uses several different aria-labels across versions.
      const chatToggle = document.querySelector(
        'button[aria-label="Chat with everyone"],'
        + 'button[aria-label="Show everyone chat"],'
        + 'button[data-tooltip="Chat with everyone"],'
        + 'button[jsname="CQylAd"]'
      );
      if (chatToggle && chatToggle.getAttribute("aria-pressed") !== "true") {
        chatToggle.click();
        await new Promise((r) => setTimeout(r, 1200));
      }

      // Chat textarea — try several selectors; retry once after another second.
      let input = document.querySelector(
        'textarea[aria-label="Send a message"],'
        + 'textarea[placeholder="Send a message"],'
        + 'textarea[jsname="YPqjbf"]'
      );
      if (!input) {
        await new Promise((r) => setTimeout(r, 1000));
        input = document.querySelector(
          'textarea[aria-label="Send a message"],'
          + 'textarea[placeholder="Send a message"],'
          + 'textarea[jsname="YPqjbf"]'
        );
      }
      if (!input) throw new Error("chat input not found");

      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      nativeSetter.call(input, CONSENT_MESSAGE);
      input.dispatchEvent(new Event("input", { bubbles: true }));

      await new Promise((r) => setTimeout(r, 200));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
      );

      chrome.runtime.sendMessage({ type: "CONSENT_INJECTED", ok: true });
    } catch (e) {
      // Non-fatal — DB-level consent record is written regardless.
      chrome.runtime.sendMessage({ type: "CONSENT_INJECTED", ok: false, error: e.message });
    }
  }

  function getParticipants() {
    if (!platform) return [];
    const sel = PARTICIPANT_SELECTORS[platform];
    return Array.from(document.querySelectorAll(sel))
      .map((el) => el.textContent.trim())
      .filter(Boolean);
  }

  function checkMeetingState() {
    const p = detectPlatform();
    if (!p) {
      if (inMeeting) sendEnded();
      return;
    }
    platform = p;

    // Check if meeting ended
    const endedEl = document.querySelector(ENDED_SELECTORS[platform]);
    if (endedEl && inMeeting) {
      sendEnded();
      return;
    }

    // Check if we just entered
    const activeEl = document.querySelector(IN_MEETING_SELECTORS[platform]);
    if (activeEl && !inMeeting) {
      inMeeting = true;
      meetingTitle = document.title.replace(/ – Google Meet$| – Zoom$/, "").trim();
      chrome.runtime.sendMessage({
        type: "MEETING_STARTED",
        platform,
        url: location.href,
        title: meetingTitle,
      });
      injectConsentMessage();
    }
  }

  function sendEnded() {
    inMeeting = false;
    consentSent = false;
    sessionStorage.removeItem(VS_CONSENT_KEY);
    chrome.runtime.sendMessage({
      type: "MEETING_ENDED",
      platform,
      roster: getParticipants(),
    });
  }

  // Poll every 3 seconds — meet DOM changes don't always fire mutation events
  checkInterval = setInterval(checkMeetingState, 3000);
  checkMeetingState();

  // Also handle SPA navigation (Zoom/Teams are SPAs)
  const _origPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _origPushState(...args);
    checkMeetingState();
  };
  window.addEventListener("popstate", checkMeetingState);
})();
