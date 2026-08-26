/**
 * Background service worker — the brain of the companion extension.
 *
 * Responsibilities:
 *  - Listen for MEETING_STARTED / MEETING_ENDED from content scripts
 *  - Manage one CaptureSession per meeting tab
 *  - Forward audio chunks from the offscreen document to the backend
 *  - Capture tab screenshots (keyframes) every 30 seconds
 *  - Call finalize on meeting end or tab close
 *  - Handle service worker restarts (recover state from chrome.storage.session)
 *
 * Tab-capture architecture (MV3 constraint):
 *  chrome.tabCapture.getMediaStreamId is blocked from a service worker unless
 *  the extension was "invoked" for that tab by a real user gesture (clicking
 *  the extension icon / popup). Content-script messages do NOT count.
 *  Solution: on MEETING_STARTED, store a pending-meeting record and badge the
 *  icon. The popup calls getMediaStreamId (popup IS a user-gesture context) and
 *  sends STREAM_ID_READY back. This SW then sets up the session + offscreen doc.
 */

import { createSession, uploadChunk, uploadKeyframe, finalizeSession, getEscalations } from "../lib/api.js";

console.info("[VS] service worker loaded");

// ─── State ───────────────────────────────────────────────────────────────────

const ACTIVE_KEY   = "vs_active_recordings";
const PENDING_KEY  = "vs_pending_meetings";   // meeting detected, not yet recording

async function getActiveRecordings() {
  const r = await chrome.storage.session.get(ACTIVE_KEY);
  return r[ACTIVE_KEY] ?? {};
}
async function setActiveRecordings(map) {
  await chrome.storage.session.set({ [ACTIVE_KEY]: map });
}
async function getPendingMeetings() {
  const r = await chrome.storage.session.get(PENDING_KEY);
  return r[PENDING_KEY] ?? {};
}
async function setPendingMeetings(map) {
  await chrome.storage.session.set({ [PENDING_KEY]: map });
}
async function getOrgId() {
  const r = await chrome.storage.local.get("vs_org_id");
  return r.vs_org_id ?? null;
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

// ─── Badge helpers ────────────────────────────────────────────────────────────

function setBadge(text, color, tabId) {
  const opts = tabId ? { text, tabId } : { text };
  chrome.action.setBadgeText(opts).catch(() => {});
  if (color) {
    const copts = tabId ? { color, tabId } : { color };
    chrome.action.setBadgeBackgroundColor(copts).catch(() => {});
  }
}

// ─── Core start/stop ─────────────────────────────────────────────────────────

const _settingUp = new Set();

// streamId arrives from the popup (the only MV3-safe context for tabCapture).
async function startRecording(tabId, { platform, url, title }, streamId) {
  if (_settingUp.has(tabId)) return;
  _settingUp.add(tabId);
  try {
    const orgId = await getOrgId();
    if (!orgId) {
      console.warn("[VS] cannot start recording: no org_id stored");
      return;
    }

    const recordings = await getActiveRecordings();
    if (recordings[tabId]?.sessionId && !recordings[tabId]?.finalized) {
      console.warn("[VS] already recording tab", tabId);
      return;
    }

    let sessionId;
    try {
      const resp = await createSession(orgId, { title, meetingUrl: url, platform });
      sessionId = resp.session_id;
    } catch (e) {
      const errMsg = e?.message ?? String(e);
      console.error("[VS] createSession failed:", errMsg);
      chrome.notifications.create("vs_capture_error", {
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

  recordings[tabId] = { ...latestRec, finalized: true };
  await setActiveRecordings(recordings);
  await closeOffscreenDocument();
  setBadge("", null, tabId);
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
    recordings[tabId] = { ...rec, keyframeSeq: seq + 1 };
    await setActiveRecordings(recordings);
  } catch (e) {
    console.warn("[VS] keyframe upload failed:", e);
  }
}

// ─── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;

  switch (msg.type) {

    // Content script detected a meeting. Store as "pending" and badge the icon
    // so the user knows to click it. The popup will call getMediaStreamId (the
    // only MV3-permitted context for tabCapture) and send STREAM_ID_READY.
    case "MEETING_STARTED":
      if (tabId) {
        (async () => {
          const pending = await getPendingMeetings();
          const recordings = await getActiveRecordings();
          // Don't overwrite an active recording
          if (recordings[tabId]?.sessionId && !recordings[tabId]?.finalized) return;
          pending[tabId] = { platform: msg.platform, url: msg.url, title: msg.title };
          await setPendingMeetings(pending);
          setBadge("●", "#F59E0B", tabId); // amber = waiting for user to click icon
        })();
      }
      break;

    // Popup opened (user gesture) → popup called getMediaStreamId → sends here.
    case "STREAM_ID_READY": {
      const { tabId: streamTabId, streamId } = msg;
      if (!streamTabId || !streamId) break;
      (async () => {
        const pending = await getPendingMeetings();
        const meeting = pending[streamTabId];
        if (!meeting) {
          console.warn("[VS] STREAM_ID_READY for unknown tab", streamTabId);
          return;
        }
        delete pending[streamTabId];
        await setPendingMeetings(pending);
        await startRecording(streamTabId, meeting, streamId);
      })();
      break;
    }

    case "MEETING_ENDED":
      if (tabId) {
        // Clear pending if meeting ended before user clicked icon
        (async () => {
          const pending = await getPendingMeetings();
          if (pending[tabId]) {
            delete pending[tabId];
            await setPendingMeetings(pending);
            setBadge("", null, tabId);
          }
        })();
        stopRecording(tabId, msg.roster ?? []);
      }
      break;

    case "AUDIO_CHUNK":
      _handleAudioChunk(msg);
      break;

    case "GET_STATUS":
      getActiveRecordings().then((r) => {
        const rec = tabId ? r[tabId] : null;
        chrome.runtime.sendMessage({ type: "STATUS_RESPONSE", recording: rec });
      });
      break;

    case "CONSENT_INJECTED":
      if (msg.ok) {
        console.info("[VS] consent notice posted to meeting chat");
      } else {
        console.warn("[VS] consent chat injection failed (DB-level record still written):", msg.error);
      }
      break;

    case "STOP_REQUESTED": {
      const stopTabId = msg.tabId ?? tabId;
      if (stopTabId) stopRecording(stopTabId, []);
      break;
    }
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
    if (msg.seq + 1 > rec.chunkSeq) {
      recordings[tabId] = { ...rec, chunkSeq: msg.seq + 1 };
      await setActiveRecordings(recordings);
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
  const orgId = await getOrgId();
  if (!orgId) return;

  let resp;
  try {
    resp = await getEscalations(orgId);
  } catch (e) {
    return;
  }

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
      message: `"${esc.title}" — the automated bot couldn't get in. Click to capture from your browser instead.`,
      priority: 2,
    });
    await chrome.storage.session.set({
      [`vs_escalation_url_${esc.bot_session_id}`]: esc.join_url,
    });
  }
  await chrome.storage.local.set({ [SEEN_ESCALATIONS_KEY]: Array.from(seen) });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
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
  // Clear any pending-meeting state for the closed tab
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
        recordings[tabId] = { ...latestRec, finalized: true };
        await setActiveRecordings(recordings);
      }
    }
  }
});
