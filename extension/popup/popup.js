/**
 * Popup UI controller.
 * Handles sign-in/out, displays recording status, and — critically — triggers
 * tab audio capture via getMediaStreamId when the user opens the popup while a
 * meeting is pending. The popup is the only MV3 context with a real user
 * gesture that allows chrome.tabCapture.getMediaStreamId to succeed.
 */
import { VS_SUPABASE_URL, VS_SUPABASE_ANON_KEY } from "../lib/config.js";
import { getStoredSession, setStoredSession, clearStoredSession } from "../lib/auth.js";

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const views = {
  signin:     document.getElementById("view-signin"),
  idle:       document.getElementById("view-idle"),
  recording:  document.getElementById("view-recording"),
  processing: document.getElementById("view-processing"),
};

const $email     = document.getElementById("email-input");
const $password  = document.getElementById("password-input");
const $signinBtn = document.getElementById("signin-btn");
const $signinErr = document.getElementById("signin-error");
const $signoutBtn = document.getElementById("signout-btn");
const $stopBtn   = document.getElementById("stop-btn");
const $title     = document.getElementById("meeting-title");
const $elapsed   = document.getElementById("elapsed-time");
const $chunks    = document.getElementById("chunk-count");
const $frames    = document.getElementById("frame-count");
const $hint      = document.querySelector("#view-idle .hint");

// ─── View management ─────────────────────────────────────────────────────────

function showView(name) {
  for (const [k, el] of Object.entries(views)) {
    el.classList.toggle("hidden", k !== name);
  }
}

// ─── Sign in ─────────────────────────────────────────────────────────────────

$signinBtn.addEventListener("click", async () => {
  const email    = $email.value.trim();
  const password = $password.value;
  if (!email || !password) {
    showError("Enter your email and password.");
    return;
  }
  $signinBtn.disabled = true;
  $signinBtn.textContent = "Signing in…";
  try {
    const resp = await fetch(`${VS_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: VS_SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json();
    if (!resp.ok) { showError(data.error_description ?? "Sign-in failed."); return; }

    const session = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Math.floor(Date.now() / 1000) + data.expires_in,
    };
    await setStoredSession(session);
    await _fetchAndStoreOrgId(session.access_token);
    showView("idle");
  } catch (e) {
    showError("Network error — is VisualSprint running?");
  } finally {
    $signinBtn.disabled = false;
    $signinBtn.textContent = "Sign in";
  }
});

async function _fetchAndStoreOrgId(accessToken) {
  const { VS_API_BASE_URL } = await import("../lib/config.js");
  try {
    const resp = await fetch(`${VS_API_BASE_URL}/api/v1/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const orgId = data.org?.id;
    if (orgId) await chrome.storage.local.set({ vs_org_id: orgId });
  } catch { /* ignore */ }
}

function showError(msg) {
  $signinErr.textContent = msg;
  $signinErr.classList.remove("hidden");
}

// ─── Sign out ─────────────────────────────────────────────────────────────────

$signoutBtn.addEventListener("click", async () => {
  await clearStoredSession();
  await chrome.storage.local.remove("vs_org_id");
  showView("signin");
});

// ─── Stop recording button ────────────────────────────────────────────────────

$stopBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.runtime.sendMessage({ type: "STOP_REQUESTED", tabId: tab.id });
  }
  showView("processing");
});

// ─── Tab-capture trigger (called on popup open when meeting is pending) ───────
//
// The popup context has a user gesture (user clicked the extension icon).
// chrome.tabCapture.getMediaStreamId succeeds here; it would fail in the SW.
// The stream ID is forwarded to the SW via STREAM_ID_READY, and the SW
// handles the rest (createSession, offscreen document, recording).

async function _triggerCapture(tabId) {
  try {
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });
    chrome.runtime.sendMessage({ type: "STREAM_ID_READY", tabId, streamId });
    if ($hint) $hint.textContent = "Connecting audio capture…";
  } catch (e) {
    console.error("[VS popup] tabCapture failed:", e.message);
    if ($hint) $hint.textContent = "Audio capture failed: " + e.message;
  }
}

// ─── Status polling ───────────────────────────────────────────────────────────

let _pollTimer = null;

async function pollStatus() {
  const recordings = await _getActiveRecordings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const rec = tab ? recordings[tab.id] : null;

  if (rec && !rec.finalized) {
    const elapsedS = Math.floor((Date.now() - rec.startedAt) / 1000);
    $elapsed.textContent = _formatTime(elapsedS);
    $chunks.textContent  = rec.chunkSeq ?? 0;
    $frames.textContent  = rec.keyframeSeq ?? 0;
    $title.textContent   = rec.title ?? "";
    showView("recording");
  } else if (rec?.finalized) {
    showView("processing");
  } else {
    const session = await getStoredSession();
    if (!session) { showView("signin"); return; }
    showView("idle");
    // Check if a meeting is pending for this tab (detected but capture not yet started)
    if (tab) {
      const pendingStore = await chrome.storage.session.get("vs_pending_meetings");
      const pending = (pendingStore.vs_pending_meetings ?? {})[tab.id];
      if (pending && $hint) {
        $hint.textContent = "Meeting detected — capturing audio…";
      } else if ($hint) {
        $hint.textContent = "Join a Google Meet, Zoom, or Teams meeting to start capturing automatically.";
      }
    }
  }
}

async function _getActiveRecordings() {
  const r = await chrome.storage.session.get("vs_active_recordings");
  return r.vs_active_recordings ?? {};
}

function _formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async function init() {
  const session = await getStoredSession();
  if (!session) { showView("signin"); return; }

  // Check if the current tab has a meeting pending capture.
  // This MUST happen before any await on unrelated work so the user-gesture
  // context (popup open) is still active when getMediaStreamId is called.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    const recordings = await _getActiveRecordings();
    const rec = recordings[tab.id];
    const notRecording = !rec || rec.finalized;
    if (notRecording) {
      const pendingStore = await chrome.storage.session.get("vs_pending_meetings");
      const pending = (pendingStore.vs_pending_meetings ?? {})[tab.id];
      if (pending) {
        // Trigger capture immediately — we are in a user-gesture context.
        showView("idle");
        if ($hint) $hint.textContent = "Meeting detected — starting audio capture…";
        await _triggerCapture(tab.id);
      }
    }
  }

  await pollStatus();
  _pollTimer = setInterval(pollStatus, 3000);
})();
