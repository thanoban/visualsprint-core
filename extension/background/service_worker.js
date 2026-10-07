/** Durable MV3 control plane; the offscreen document owns live capture. */
import { createSession, uploadChunk, uploadKeyframe, finalizeSession, getEscalations, abortSession } from "../lib/api.js";
import { getAuthHeaders, getStoredSession } from "../lib/auth.js";
import { VS_API_BASE_URL } from "../lib/config.js";
import { pendingMedia, persistMedia, acknowledgeMedia, drainMedia } from "../lib/outbox.js";

const ACTIVE_KEY = "vs_active_recordings";
const PENDING_KEY = "vs_pending_meetings";
const POPUP_URL = "popup/popup.html";
let stateQueue = Promise.resolve();
let mediaQueue = Promise.resolve();
let flushPromise;
const starting = new Set();
const stopping = new Set();

async function recordings() {
  return (await chrome.storage.local.get(ACTIVE_KEY))[ACTIVE_KEY] ?? {};
}
function updateRecording(tabId, fields) {
  stateQueue = stateQueue.catch(() => {}).then(async () => {
    const map = await recordings();
    map[tabId] = { ...map[tabId], ...fields };
    await chrome.storage.local.set({ [ACTIVE_KEY]: map });
    return map[tabId];
  });
  return stateQueue;
}
async function pendingMeetings() {
  return (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] ?? {};
}
async function enablePopup(tabId, enabled = true) {
  await chrome.action.setPopup({ tabId, popup: enabled ? POPUP_URL : "" }).catch(() => {});
}
function badge(tabId, text, color = "#EF4444") {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}
function notify(id, title, message) {
  chrome.notifications.create(id, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title, message: String(message).slice(0, 400), priority: 1 });
}
async function orgId() {
  const stored = (await chrome.storage.local.get("vs_org_id")).vs_org_id;
  if (stored) return stored;
  const headers = await getAuthHeaders();
  if (!headers) throw new Error("Sign in through the VisualSprint popup first");
  const response = await fetch(`${VS_API_BASE_URL}/api/v1/me`, { headers });
  if (!response.ok) throw new Error("VisualSprint account could not be loaded");
  const id = (await response.json()).org?.id;
  if (!id) throw new Error("VisualSprint organization is missing");
  await chrome.storage.local.set({ vs_org_id: id });
  return id;
}
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!contexts.length) await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html", reasons: ["USER_MEDIA"],
    justification: "Record the user-selected meeting tab and microphone",
  });
}
async function detectMeeting(tabId, meeting) {
  const rec = (await recordings())[tabId];
  if (rec && !rec.finalized && !rec.stopped && rec.state !== "failed") return;
  const pending = await pendingMeetings();
  const first = !pending[tabId];
  pending[tabId] = meeting;
  await chrome.storage.local.set({ [PENDING_KEY]: pending });
  const signedIn = !!await getStoredSession();
  await enablePopup(tabId, !signedIn);
  badge(tabId, "●", "#F59E0B");
  if (first) notify(`vs_meeting_${tabId}`, "VisualSprint: meeting detected",
    signedIn ? "Click the extension icon to record this meeting tab." : "Open the extension and sign in, then click its icon to record.");
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || starting.size) return;
  const meeting = (await pendingMeetings())[tab.id];
  if (!meeting) return enablePopup(tab.id);
  starting.add(tab.id);
  let sessionId, organization;
  try {
    if (Object.values(await recordings()).some((r) => !r.finalized && !r.stopped && r.state !== "failed")) {
      throw new Error("One meeting tab can be recorded at a time. Stop the current capture first.");
    }
    organization = await orgId();
    await ensureOffscreen();
    sessionId = (await createSession(organization, { title: meeting.title, meetingUrl: meeting.url, platform: meeting.platform })).session_id;
    await updateRecording(tab.id, { sessionId, orgId: organization, platform: meeting.platform,
      title: meeting.title, startedAt: Date.now(), chunkSeq: 0, keyframeSeq: 0,
      finalized: false, stopped: false, state: "starting", error: null, roster: [] });
    // The stream ID is consumed immediately, AFTER slow account/API setup.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const result = await chrome.runtime.sendMessage({ target: "offscreen", type: "START_CAPTURE",
      streamId, sessionId, micMuted: meeting.micMuted });
    if (!result?.ok) throw new Error(result?.error ?? "Capture did not start");
    await updateRecording(tab.id, { state: "recording", microphoneCaptured: result.microphoneCaptured });
    badge(tab.id, "REC");
    await enablePopup(tab.id);
    const pending = await pendingMeetings();
    delete pending[tab.id];
    await chrome.storage.local.set({ [PENDING_KEY]: pending });
    chrome.notifications.clear(`vs_meeting_${tab.id}`);
    chrome.tabs.sendMessage(tab.id, { type: "RECORDING_STARTED" }).catch(() => {});
  } catch (error) {
    if (sessionId) {
      await updateRecording(tab.id, { state: "failed", stopped: true, error: error.message,
        abortPending: true });
      flushUploads().catch(() => {});
    }
    await enablePopup(tab.id);
    badge(tab.id, "!");
    notify("vs_capture_error", "VisualSprint: capture could not start", error.message);
  } finally { starting.delete(tab.id); }
});

async function acceptMedia(msg) {
  const map = await recordings();
  const entry = Object.entries(map).find(([, r]) => r.sessionId === msg.sessionId && !r.finalized);
  if (!entry) throw new Error("Unknown capture session");
  const [tabId, rec] = entry;
  const kind = msg.type === "KEYFRAME" ? "frame" : "audio";
  const bytes = new Uint8Array(msg.chunk);
  await persistMedia({ id: `${rec.sessionId}:${kind}:${msg.seq}`,
    orgId: rec.orgId, sessionId: rec.sessionId, seq: msg.seq,
    timestampS: msg.timestampS, kind, bytes });
  await updateRecording(tabId, kind === "audio"
    ? { chunkSeq: Math.max(rec.chunkSeq, msg.seq + 1) }
    : { keyframeSeq: Math.max(rec.keyframeSeq, msg.seq + 1) });
}

function flushUploads() {
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    await mediaQueue.catch(() => {});
    await drainMedia(await pendingMedia(), async (item) => {
      if (item.kind === "audio") await uploadChunk(item.orgId, item.sessionId, item.seq, item.bytes);
      else await uploadKeyframe(item.orgId, item.sessionId, item.seq, item.timestampS, item.bytes);
    }, acknowledgeMedia);
    // No pending media remains. Only now can the server close the manifest.
    for (const [tabId, rec] of Object.entries(await recordings())) {
      if (rec.finalized || !rec.stopped) continue;
      if ((await pendingMedia()).some((item) => item.sessionId === rec.sessionId)) continue;
      if (rec.abortPending) {
        await abortSession(rec.orgId, rec.sessionId, rec.error ?? "Capture failed");
        await updateRecording(tabId, { abortPending: false, finalized: true });
        continue;
      }
      if (!rec.totalChunks) continue;
      await finalizeSession(rec.orgId, rec.sessionId, rec.totalChunks, rec.roster ?? [], {
        microphone_captured: rec.microphoneCaptured ?? false, duration_s: rec.durationS ?? 0,
      });
      await updateRecording(tabId, { finalized: true, state: "processing", error: null });
      badge(Number(tabId), "");
      notify(`vs_saved_${rec.sessionId}`, "VisualSprint: recording uploaded",
        "Transcript, screen evidence and report are queued in your dashboard.");
    }
  })().finally(() => { flushPromise = null; });
  return flushPromise;
}

async function captureStopped(result) {
  const entry = Object.entries(await recordings()).find(([, r]) => r.sessionId === result.sessionId);
  if (!entry) return;
  const [tabId] = entry;
  await updateRecording(tabId, { stopped: true, state: result.ok ? "uploading" : "failed",
    totalChunks: result.totalChunks, microphoneCaptured: result.microphoneCaptured,
    durationS: result.durationS, error: result.error ?? null,
    abortPending: !result.ok || !result.totalChunks });
  badge(Number(tabId), result.ok ? "UP" : "!", "#F59E0B");
  await enablePopup(Number(tabId));
  if (!Object.values(await recordings()).some((r) => !r.stopped && !r.finalized)) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  flushUploads().catch((error) => {
    notify("vs_upload_pending", "VisualSprint: uploads waiting", error.message);
  });
}

async function stopRecording(tabId, roster) {
  const rec = (await recordings())[tabId];
  if (!rec || rec.finalized || rec.stopped || stopping.has(tabId)) return;
  stopping.add(tabId);
  try {
    await updateRecording(tabId, { state: "stopping", roster: roster ?? rec.roster ?? [] });
    const result = await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAPTURE" });
    if (result?.sessionId) await captureStopped(result);
  } catch (error) {
    // Keep uploaded prefix + local outbox when the recorder context disappeared.
    await captureStopped({ sessionId: rec.sessionId, ok: true, totalChunks: rec.chunkSeq,
      microphoneCaptured: rec.microphoneCaptured, durationS: (Date.now() - rec.startedAt) / 1000 });
    notify("vs_capture_interrupted", "VisualSprint: capture interrupted", error.message);
  } finally { stopping.delete(tabId); }
}

async function handleMessage(msg, sender) {
  const tabId = sender.tab?.id;
  switch (msg.type) {
    case "MEETING_STARTED":
      if (tabId) await detectMeeting(tabId, msg);
      break;
    case "MEETING_ENDED":
      if (tabId) {
        const pending = await pendingMeetings(); delete pending[tabId];
        await chrome.storage.local.set({ [PENDING_KEY]: pending });
        await enablePopup(tabId);
        await stopRecording(tabId, msg.roster);
      }
      break;
    case "MEETING_HEARTBEAT":
      if (tabId) {
        const rec = (await recordings())[tabId];
        if (rec && !rec.stopped && !rec.finalized) {
          await updateRecording(tabId, { roster: msg.roster ?? rec.roster });
          chrome.runtime.sendMessage({ target: "offscreen", type: "MIC_STATE", muted: msg.micMuted }).catch(() => {});
        }
      }
      break;
    case "STOP_REQUESTED":
      await stopRecording(msg.tabId ?? tabId);
      break;
    case "AUDIO_CHUNK":
    case "KEYFRAME":
      mediaQueue = mediaQueue.catch(() => {}).then(() => acceptMedia(msg));
      await mediaQueue;
      flushUploads().catch(() => {}); // Upload failures retain the durable entry.
      break;
    case "CAPTURE_STOPPED": await captureStopped(msg); break;
    case "OFFSCREEN_ERROR": {
      const entry = Object.entries(await recordings()).find(([, r]) => r.sessionId === msg.sessionId);
      if (entry) await stopRecording(Number(entry[0]));
      notify("vs_media_error", "VisualSprint: recording interrupted", msg.error);
      break;
    }
  }
  return { ok: true };
}

// Chrome's message listener itself must be synchronous and return true to keep
// the response channel open. Offscreen pages cannot use storage directly.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.target === "offscreen") return;
  if (["AUDIO_CHUNK", "KEYFRAME", "CAPTURE_STOPPED", "OFFSCREEN_ERROR", "CAPTURE_STARTED"].includes(msg.type)
    && sender.url !== chrome.runtime.getURL("offscreen/offscreen.html")) {
    respond({ ok: false, error: "Untrusted media sender" }); return;
  }
  handleMessage(msg, sender).then(respond).catch((error) => respond({ ok: false, error: error.message }));
  return true;
});

chrome.alarms.create("vs_upload_retry", { periodInMinutes: 0.5 });
chrome.alarms.create("vs_escalation_poll", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "vs_upload_retry") await flushUploads().catch(() => {});
  if (alarm.name === "vs_escalation_poll") {
    const id = (await chrome.storage.local.get("vs_org_id")).vs_org_id;
    if (!id) return;
    const response = await getEscalations(id).catch(() => null);
    const seen = new Set((await chrome.storage.local.get("vs_seen_escalations")).vs_seen_escalations ?? []);
    for (const entry of response?.escalations ?? []) {
      if (seen.has(entry.bot_session_id)) continue;
      seen.add(entry.bot_session_id);
      notify(`vs_escalation_${entry.bot_session_id}`, "VisualSprint: bot admission blocked",
        "Join the meeting yourself, then click the companion icon to record your meeting tab.");
    }
    await chrome.storage.local.set({ vs_seen_escalations: Array.from(seen).slice(-100) });
  }
});
chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith("vs_meeting_")) return;
  const tabId = Number(id.slice("vs_meeting_".length));
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => stopRecording(tabId).catch(console.error));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") stopRecording(tabId).catch(console.error);
});
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({ url: [
    "https://meet.google.com/*", "https://*.zoom.us/*",
    "https://teams.microsoft.com/*", "https://teams.live.com/*", "https://teams.cloud.microsoft/*",
  ] })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/detector.js"] }).catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(async () => {
  // Browser restart destroys the offscreen recorder, but IndexedDB/local state
  // survives. Recover the persisted prefix and retry its uploads/finalize.
  await chrome.storage.local.remove(PENDING_KEY);
  for (const [tabId, rec] of Object.entries(await recordings())) {
    if (!rec.finalized && !rec.stopped) await updateRecording(tabId, {
      stopped: true, totalChunks: rec.chunkSeq, state: "uploading",
      durationS: Math.min(18000, (Date.now() - rec.startedAt) / 1000),
    });
  }
  flushUploads().catch(() => {});
});
