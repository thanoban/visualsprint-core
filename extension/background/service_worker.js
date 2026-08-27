/**
 * Background service worker — the brain of the companion extension.
 *
 * Tab-capture architecture (MV3):
 *   chrome.tabCapture.getMediaStreamId requires user invocation. Content-script
 *   messages do NOT count. The only reliable approach is chrome.action.onClicked,
 *   which fires when the user clicks the icon AND no popup is set for that tab.
 *
 *   Flow:
 *     1. MEETING_STARTED  → store pending record, amber badge, disable popup for tab
 *     2. User clicks icon → onClicked fires in SW (user-gesture invocation)
 *     3. SW calls getMediaStreamId, re-enables popup, starts recording
 *     4. MEETING_ENDED / tab close → finalize, clear state, re-enable popup
 */

import { createSession, uploadChunk, uploadKeyframe, finalizeSession, getEscalations } from "../lib/api.js";
import { getAuthHeaders } from "../lib/auth.js";
import { VS_API_BASE_URL } from "../lib/config.js";

console.info("[VS] service worker loaded");

// ─── Storage helpers ──────────────────────────────────────────────────────────

const ACTIVE_KEY  = "vs_active_recordings";
const PENDING_KEY = "vs_pending_meetings";

async function getActiveRecordings() {
  const r = await chrome.storage.session.get(ACTIVE_KEY);
  return r[ACTIVE_KEY] ?? {};
}
async function setActiveRecordings(map) {
  await chrome.storage.session.set({ [ACTIVE_KEY]: map });
}
async function getPendingMeetings() {
  const r = await chrome.storage.local.get(PENDING_KEY);
  return r[PENDING_KEY] ?? {};
}
async function setPendingMeetings(map) {
  await chrome.storage.local.set({ [PENDING_KEY]: map });
}

// Removes pending entries whose tabs no longer exist. Called on SW startup so
// stale entries left by a previous Chrome session don't block new detections.
async function purgeStalePendingMeetings() {
  const pending = await getPendingMeetings();
  const tabIds = Object.keys(pending).map(Number);
  if (tabIds.length === 0) return;
  const cleaned = { ...pending };
  for (const tabId of tabIds) {
    try { await chrome.tabs.get(tabId); } catch { delete cleaned[tabId]; }
  }
  await setPendingMeetings(cleaned);
}

// Reads cached org_id; if missing, fetches it from /api/v1/me and caches it.
async function ensureOrgId() {
  const r = await chrome.storage.local.get("vs_org_id");
  if (r.vs_org_id) return r.vs_org_id;
  const headers = await getAuthHeaders().catch(() => null);
  if (!headers) return null;
  try {
    const resp = await fetch(`${VS_API_BASE_URL}/api/v1/me`, {
      headers: { Authorization: headers.Authorization },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const orgId = data.org?.id;
    if (orgId) await chrome.storage.local.set({ vs_org_id: orgId });
    return orgId ?? null;
  } catch { return null; }
}

// ─── Popup enable/disable per tab ─────────────────────────────────────────────

const POPUP_URL = "popup/popup.html";

function enablePopup(tabId) {
  chrome.action.setPopup({ tabId, popup: POPUP_URL }).catch(() => {});
}
function disablePopup(tabId) {
  // Disabling the popup for this tab makes clicks fire chrome.action.onClicked
  // in the service worker instead of opening the popup window.
  chrome.action.setPopup({ tabId, popup: "" }).catch(() => {});
}

// ─── Badge helpers ────────────────────────────────────────────────────────────

function setBadge(text, color, tabId) {
  const opts = tabId ? { text, tabId } : { text };
  chrome.action.setBadgeText(opts).catch(() => {});
  if (color) {
    const copts = tabId ? { color, tabId } : { color };
    chrome.action.setBadgeBackgroundColor(copts).catch(() => {});
  }
}

// ─── Offscreen document ───────────────────────────────────────────────────────

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  }).catch(() => []);
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL("offscreen/offscreen.html"),
    reasons: ["USER_MEDIA"],
    justification: "Capture meeting audio from the user's own browser tab",
  });
}

async function closeOffscreenDocument() {
  await chrome.offscreen.closeDocument().catch(() => {});
}

// ─── User clicks icon (popup disabled for this tab) ───────────────────────────
//
// chrome.action.onClicked fires only when no popup is set for the active tab.
// We disable the popup when a meeting is pending so this handler can call
// chrome.tabCapture.getMediaStreamId — which requires user invocation and IS
// satisfied by this event.

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  if (!tabId) return;

  const pending = await getPendingMeetings();
  const meeting = pending[tabId];
  if (!meeting) {
    // Unexpected — restore popup so future clicks work normally.
    enablePopup(tabId);
    return;
  }

  // Get the stream ID — valid here because onClicked is a user invocation.
  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });
  } catch (e) {
    console.error("[VS] tabCapture.getMediaStreamId failed:", e.message);
    enablePopup(tabId);
    setBadge("!", "#EF4444", tabId);
    chrome.notifications.create("vs_capture_error_tab", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "VisualSprint: Audio capture failed",
      message: e.message,
      priority: 2,
    });
    return;
  }

  // Clear the "click to record" notification and reset badge title.
  chrome.notifications.clear(`vs_meeting_${tabId}`);
  chrome.action.setTitle({ tabId, title: "VisualSprint" }).catch(() => {});
  // Re-enable popup BEFORE startRecording so any subsequent icon click shows status.
  enablePopup(tabId);
  delete pending[tabId];
  await setPendingMeetings(pending);
  await startRecording(tabId, meeting, streamId);
});

// ─── Core start/stop ─────────────────────────────────────────────────────────

const _settingUp = new Set();

async function startRecording(tabId, { platform, url, title }, streamId) {
  if (_settingUp.has(tabId)) return;
  _settingUp.add(tabId);
  try {
    const recordings = await getActiveRecordings();
    if (recordings[tabId]?.sessionId && !recordings[tabId]?.finalized) {
      console.warn("[VS] already recording tab", tabId);
      return;
    }

    const orgId = await ensureOrgId();
    if (!orgId) {
      console.warn("[VS] cannot start recording: not signed in");
      setBadge("!", "#EF4444", tabId);
      chrome.notifications.create("vs_signin_required", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "VisualSprint: Sign-in required",
        message: "Open the VisualSprint icon and sign in to start capturing meetings.",
        priority: 2,
      });
      return;
    }

    let sessionId;
    try {
      const resp = await createSession(orgId, { title, meetingUrl: url, platform });
      sessionId = resp.session_id;
    } catch (e) {
      const errMsg = e?.message ?? String(e);
      console.error("[VS] createSession failed:", errMsg);
      chrome.notifications.create("vs_session_error", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "VisualSprint: Session creation failed",
        message: errMsg,
        priority: 2,
      });
      return;
    }

    recordings[tabId] = {
      sessionId,
      orgId,
      chunkSeq: 0,
      keyframeSeq: 0,
      platform,
      title,
      startedAt: Date.now(),
      finalized: false,
    };
    await setActiveRecordings(recordings);

    await ensureOffscreenDocument();
    chrome.runtime.sendMessage({ type: "START_CAPTURE", streamId, sessionId });

    _startKeyframeLoop(tabId);
    setBadge("REC", "#EF4444", tabId);
    console.info("[VS] recording started", { tabId, sessionId, platform });
  } finally {
    _settingUp.delete(tabId);
  }
}

async function stopRecording(tabId, roster = []) {
  const recordings = await getActiveRecordings();
  const rec = recordings[tabId];
  if (!rec || rec.finalized) return;

  chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  _stopKeyframeLoop(tabId);

  await new Promise((r) => setTimeout(r, 2000));

  const latest = await getActiveRecordings();
  const latestRec = latest[tabId];
  const totalChunks = latestRec?.chunkSeq ?? rec.chunkSeq;

  try {
    await finalizeSession(rec.orgId, rec.sessionId, totalChunks, roster);
    console.info("[VS] finalized", { sessionId: rec.sessionId, totalChunks });
  } catch (e) {
    console.error("[VS] finalize failed:", e);
  }

  latest[tabId] = { ...latestRec, finalized: true };
  await setActiveRecordings(latest);
  await closeOffscreenDocument();
  setBadge("", null, tabId);
  enablePopup(tabId);
}

// ─── Keyframe loop ───────────────────────────────────────────────────────────

const _keyframeTimers = {};

function _startKeyframeLoop(tabId) {
  _keyframeTimers[tabId] = setInterval(() => _captureKeyframe(tabId), 30_000);
}

function _stopKeyframeLoop(tabId) {
  if (_keyframeTimers[tabId]) {
    clearInterval(_keyframeTimers[tabId]);
    delete _keyframeTimers[tabId];
  }
}

async function _captureKeyframe(tabId) {
  const recordings = await getActiveRecordings();
  const rec = recordings[tabId];
  if (!rec || rec.finalized) return;

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(
      (await chrome.tabs.get(tabId)).windowId,
      { format: "jpeg", quality: 60 }
    );
  } catch (e) {
    console.warn("[VS] keyframe capture failed:", e);
    return;
  }

  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const seq = rec.keyframeSeq;
  const timestampS = (Date.now() - rec.startedAt) / 1000;

  try {
    await uploadKeyframe(rec.orgId, rec.sessionId, seq, timestampS, bytes);
    const updated = await getActiveRecordings();
    updated[tabId] = { ...updated[tabId], keyframeSeq: seq + 1 };
    await setActiveRecordings(updated);
  } catch (e) {
    console.warn("[VS] keyframe upload failed:", e);
  }
}

// ─── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;

  switch (msg.type) {

    // Content script detected a meeting. Store as pending, badge the icon,
    // and disable the popup for this tab so clicking fires onClicked (the
    // only MV3-safe context for chrome.tabCapture.getMediaStreamId).
    case "MEETING_STARTED":
      if (tabId) {
        (async () => {
          const [recordings, pending] = await Promise.all([
            getActiveRecordings(), getPendingMeetings(),
          ]);
          // Skip if already recording this tab
          if (recordings[tabId]?.sessionId && !recordings[tabId]?.finalized) return;
          // Skip if already pending — content script polls every 3 s, dedupe here
          if (pending[tabId]) return;

          pending[tabId] = { platform: msg.platform, url: msg.url, title: msg.title };
          await setPendingMeetings(pending);
          setBadge("●", "#F59E0B", tabId); // amber = click icon to start
          chrome.action.setTitle({ tabId, title: "VisualSprint — click to start recording" }).catch(() => {});
          disablePopup(tabId);

          // Notify the user — the amber badge is easy to miss
          chrome.notifications.create(`vs_meeting_${tabId}`, {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: "VisualSprint: meeting detected",
            message: "Click the VisualSprint icon in the toolbar to start recording.",
            priority: 1,
          });
          console.info("[VS] meeting detected, waiting for icon click", { tabId, platform: msg.platform });
        })();
      }
      break;

    case "MEETING_ENDED":
      if (tabId) {
        (async () => {
          const pending = await getPendingMeetings();
          if (pending[tabId]) {
            delete pending[tabId];
            await setPendingMeetings(pending);
            setBadge("", null, tabId);
            chrome.action.setTitle({ tabId, title: "VisualSprint" }).catch(() => {});
            chrome.notifications.clear(`vs_meeting_${tabId}`);
            enablePopup(tabId);
          }
        })();
        stopRecording(tabId, msg.roster ?? []);
      }
      break;

    case "AUDIO_CHUNK":
      _handleAudioChunk(msg);
      break;

    case "STOP_REQUESTED": {
      const stopTabId = msg.tabId ?? tabId;
      if (stopTabId) stopRecording(stopTabId, []);
      break;
    }

    case "CONSENT_INJECTED":
      if (msg.ok) {
        console.info("[VS] consent notice posted to meeting chat");
      } else {
        // Non-fatal — DB-level consent record is written regardless.
        console.info("[VS] consent chat injection skipped (chat panel not available):", msg.error);
      }
      break;
  }
});

async function _handleAudioChunk(msg) {
  const recordings = await getActiveRecordings();
  const tabId = Object.keys(recordings).find(
    (id) => recordings[id].sessionId === msg.sessionId
  );
  if (!tabId) return;

  const rec = recordings[tabId];
  if (rec.finalized) return;

  try {
    const chunkBytes = msg.chunk instanceof Uint8Array
      ? msg.chunk
      : new Uint8Array(msg.chunk);
    await uploadChunk(rec.orgId, rec.sessionId, msg.seq, chunkBytes);
    const updated = await getActiveRecordings();
    if (msg.seq + 1 > (updated[tabId]?.chunkSeq ?? 0)) {
      updated[tabId] = { ...updated[tabId], chunkSeq: msg.seq + 1 };
      await setActiveRecordings(updated);
    }
  } catch (e) {
    console.error("[VS] chunk upload failed (seq", msg.seq, "):", e);
  }
}

// ─── Bot-blocked → companion escalation ──────────────────────────────────────

const ESCALATION_ALARM = "vs_escalation_poll";
const SEEN_ESCALATIONS_KEY = "vs_seen_escalations";

chrome.alarms.create(ESCALATION_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ESCALATION_ALARM) checkEscalations();
});

async function checkEscalations() {
  const r = await chrome.storage.local.get("vs_org_id");
  const orgId = r.vs_org_id;
  if (!orgId) return;
  let resp;
  try { resp = await getEscalations(orgId); } catch { return; }

  const seenStore = await chrome.storage.local.get(SEEN_ESCALATIONS_KEY);
  const seen = new Set(seenStore[SEEN_ESCALATIONS_KEY] ?? []);
  const fresh = (resp.escalations ?? []).filter((e) => !seen.has(e.bot_session_id));
  if (fresh.length === 0) return;

  for (const esc of fresh) {
    seen.add(esc.bot_session_id);
    chrome.notifications.create(`vs_escalation_${esc.bot_session_id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Meeting bot blocked in lobby",
      message: `"${esc.title}" — the bot couldn't get in. Click to capture from your browser instead.`,
      priority: 2,
    });
    await chrome.storage.session.set({
      [`vs_escalation_url_${esc.bot_session_id}`]: esc.join_url,
    });
  }
  await chrome.storage.local.set({ [SEEN_ESCALATIONS_KEY]: Array.from(seen) });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  // "Click to record" notification — focus the Meet tab so the amber badge is visible.
  if (notificationId.startsWith("vs_meeting_")) {
    const tabId = Number(notificationId.slice("vs_meeting_".length));
    chrome.notifications.clear(notificationId);
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch { /* tab may have closed */ }
    return;
  }

  if (!notificationId.startsWith("vs_escalation_")) return;
  const botSessionId = notificationId.slice("vs_escalation_".length);
  const key = `vs_escalation_url_${botSessionId}`;
  const stored = await chrome.storage.session.get(key);
  const url = stored[key];
  chrome.notifications.clear(notificationId);
  if (!url) return;
  try {
    const tabs = await chrome.tabs.query({ url: `${url}*` });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
      return;
    }
  } catch (e) {
    console.warn("[VS] tab lookup for escalation failed:", e.message);
  }
  chrome.tabs.create({ url });
});

// ─── Tab close → auto-finalize ────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const pending = await getPendingMeetings();
  if (pending[tabId]) {
    delete pending[tabId];
    await setPendingMeetings(pending);
  }
  const recordings = await getActiveRecordings();
  const rec = recordings[tabId];
  if (rec && !rec.finalized) {
    console.info("[VS] tab closed mid-recording, auto-finalizing", tabId);
    await stopRecording(tabId, []);
  }
});

// ─── Service worker restart recovery ─────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  await purgeStalePendingMeetings();
  const recordings = await getActiveRecordings();
  for (const [tabIdStr, rec] of Object.entries(recordings)) {
    if (rec.finalized) continue;
    const tabId = Number(tabIdStr);
    try {
      await chrome.tabs.get(tabId);
      console.warn("[VS] SW restarted with active recording, finalizing", tabId);
      await stopRecording(tabId, []);
    } catch {
      const latest = await getActiveRecordings();
      const latestRec = latest[tabId];
      if (latestRec && !latestRec.finalized) {
        await finalizeSession(rec.orgId, rec.sessionId, rec.chunkSeq, []).catch(console.error);
        latest[tabId] = { ...latestRec, finalized: true };
        await setActiveRecordings(latest);
      }
    }
  }
});
