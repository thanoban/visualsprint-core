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
 */

import { createSession, uploadChunk, uploadKeyframe, finalizeSession, getEscalations } from "../lib/api.js";
import { getStoredSession } from "../lib/auth.js";

// ─── State ───────────────────────────────────────────────────────────────────
// Keyed by tabId. Persisted in chrome.storage.session so SW restarts recover.
// Shape: { sessionId, orgId, chunkSeq, keyframeSeq, platform, startedAt, finalized }

const ACTIVE_KEY = "vs_active_recordings";

async function getActiveRecordings() {
  const r = await chrome.storage.session.get(ACTIVE_KEY);
  return r[ACTIVE_KEY] ?? {};
}

async function setActiveRecordings(map) {
  await chrome.storage.session.set({ [ACTIVE_KEY]: map });
}

async function getOrgId() {
  // org_id is stored when the user signs in via the popup.
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

// ─── Core start/stop ─────────────────────────────────────────────────────────

async function startRecording(tabId, { platform, url, title }) {
  const orgId = await getOrgId();
  if (!orgId) {
    console.warn("[VS] cannot start recording: no org_id stored (sign in via popup)");
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
    console.error("[VS] createSession failed:", e);
    return;
  }

  // Reserve this tab immediately so the next 3-second detection tick doesn't
  // create a duplicate session while tabCapture or offscreen setup is in progress.
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

  // tabCapture requires the target tab to be the active tab in a focused window.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {}

  // Tab capture → offscreen doc
  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });
  } catch (e) {
    const errMsg = e?.message ?? String(e);
    console.error("[VS] tabCapture.getMediaStreamId failed:", errMsg);
    // Mark finalized so further detection ticks don't keep retrying.
    const cur = await getActiveRecordings();
    if (cur[tabId]) {
      cur[tabId] = { ...cur[tabId], finalized: true };
      await setActiveRecordings(cur);
    }
    chrome.notifications.create("vs_capture_error", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "VisualSprint: Audio capture failed",
      message: "Tab audio could not start: " + errMsg + ". Refresh the meeting tab and try again.",
      priority: 2,
    });
    return;
  }

  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({ type: "START_CAPTURE", streamId, sessionId });

  // Start keyframe loop
  _startKeyframeLoop(tabId);

  console.info("[VS] recording started", { tabId, sessionId, platform });
}

async function stopRecording(tabId, roster = []) {
  const recordings = await getActiveRecordings();
  const rec = recordings[tabId];
  if (!rec || rec.finalized) return;

  // Stop the MediaRecorder in the offscreen doc
  chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  _stopKeyframeLoop(tabId);

  // Give the recorder a moment to flush the last chunk
  await new Promise((r) => setTimeout(r, 2000));

  // Reload latest chunkSeq (may have been updated while we waited)
  const latest = await getActiveRecordings();
  const latestRec = latest[tabId];
  const totalChunks = latestRec?.chunkSeq ?? rec.chunkSeq;

  try {
    await finalizeSession(rec.orgId, rec.sessionId, totalChunks, roster);
    console.info("[VS] finalized", { sessionId: rec.sessionId, totalChunks });
  } catch (e) {
    console.error("[VS] finalize failed:", e);
  }

  // Mark finalized so tab close doesn't double-finalize
  recordings[tabId] = { ...latestRec, finalized: true };
  await setActiveRecordings(recordings);
  await closeOffscreenDocument();
}

// ─── Keyframe loop ───────────────────────────────────────────────────────────

const _keyframeTimers = {};  // tabId → intervalId

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

  // Convert base64 data URL to Uint8Array
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
    case "MEETING_STARTED":
      if (tabId) startRecording(tabId, msg);
      break;

    case "MEETING_ENDED":
      if (tabId) stopRecording(tabId, msg.roster ?? []);
      break;

    case "AUDIO_CHUNK":
      _handleAudioChunk(msg);
      break;

    case "GET_STATUS":
      // Popup polls this to display recording status
      getActiveRecordings().then((r) => {
        const rec = tabId ? r[tabId] : null;
        chrome.runtime.sendMessage({ type: "STATUS_RESPONSE", recording: rec });
      });
      break;

    case "CONSENT_INJECTED":
      if (msg.ok) {
        console.info("[VS] consent notice posted to meeting chat");
      } else {
        console.warn("[VS] consent chat injection failed (recording continues; DB-level consent record still written):", msg.error);
      }
      break;

    case "STOP_REQUESTED": {
      // Popup messages have no sender.tab; tabId is passed in the message body.
      const stopTabId = msg.tabId ?? tabId;
      if (stopTabId) stopRecording(stopTabId, []);
      break;
    }
  }
});

async function _handleAudioChunk(msg) {
  const recordings = await getActiveRecordings();
  // Find the recording matching this session
  const tabId = Object.keys(recordings).find(
    (id) => recordings[id].sessionId === msg.sessionId
  );
  if (!tabId) return;

  const rec = recordings[tabId];
  if (rec.finalized) return;

  try {
    // msg.chunk arrives as a plain Array (offscreen converts ArrayBuffer before
    // sendMessage so it survives JSON serialization); reconstruct Uint8Array here.
    const chunkBytes = msg.chunk instanceof Uint8Array
      ? msg.chunk
      : new Uint8Array(msg.chunk);
    await uploadChunk(rec.orgId, rec.sessionId, msg.seq, chunkBytes);
    // Update chunkSeq to the highest seq we've uploaded (offscreen tracks its own seq)
    if (msg.seq + 1 > rec.chunkSeq) {
      recordings[tabId] = { ...rec, chunkSeq: msg.seq + 1 };
      await setActiveRecordings(recordings);
    }
  } catch (e) {
    console.error("[VS] chunk upload failed (seq", msg.seq, "):", e);
    // TODO: queue for retry
  }
}

// ─── Bot-blocked → companion escalation ──────────────────────────────────────
// If a dispatched Mode B bot times out stuck in the meeting lobby (Google
// Meet's guest-security block -- docs/03-capture.md), offer the user a
// one-click handoff to Mode C: focus/open the meeting tab, which lets the
// existing content-script detector start companion capture the moment the
// user is actually admitted. This is the "Smart Capture Router" handoff.

const ESCALATION_ALARM = "vs_escalation_poll";
const SEEN_ESCALATIONS_KEY = "vs_seen_escalations";

chrome.alarms.create(ESCALATION_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ESCALATION_ALARM) checkEscalations();
});

async function checkEscalations() {
  const orgId = await getOrgId();
  if (!orgId) return; // not signed in -- nothing to check against

  let resp;
  try {
    resp = await getEscalations(orgId);
  } catch (e) {
    return; // network hiccup or expired token -- retried on the next alarm tick
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
    console.warn("[VS] tab lookup for escalation failed, opening new tab:", e.message);
  }
  chrome.tabs.create({ url });
});

// ─── Tab close → auto-finalize ────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
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
    // Check if the tab still exists
    try {
      await chrome.tabs.get(tabId);
      // Tab still alive — re-attach keyframe loop (audio capture is gone but
      // chunks already uploaded; we'll finalize with what we have so far)
      console.warn("[VS] SW restarted with active recording, finalizing with partial data", tabId);
      await stopRecording(tabId, []);
    } catch {
      // Tab is gone — finalize what was uploaded
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
