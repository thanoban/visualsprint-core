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

import { createSession, uploadChunk, uploadKeyframe, finalizeSession } from "../lib/api.js";
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
  const existing = await chrome.offscreen.getContexts({
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
    console.error("[VS] tabCapture.getMediaStreamId failed:", e);
    return;
  }

  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({ type: "START_CAPTURE", streamId, sessionId });

  // Persist state
  recordings[tabId] = {
    sessionId,
    orgId,
    chunkSeq: 0,
    keyframeSeq: 0,
    platform,
    startedAt: Date.now(),
    finalized: false,
  };
  await setActiveRecordings(recordings);

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

    case "STOP_REQUESTED":
      if (tabId) stopRecording(tabId, []);
      break;
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
    await uploadChunk(rec.orgId, rec.sessionId, msg.seq, msg.chunk);
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
