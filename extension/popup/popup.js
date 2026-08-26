/**
 * Popup UI controller.
 * Handles sign-in/out and displays recording status.
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

    // Fetch and store the user's default org_id
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
    // me endpoint returns { orgs: [{id, role}] }; pick the first (owner) org
    const orgId = data.org?.id;
    if (orgId) await chrome.storage.local.set({ vs_org_id: orgId });
  } catch { /* ignore — user can retry by re-signing in */ }
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
    chrome.runtime.sendMessage({ type: "STOP_REQUESTED" }, { tabId: tab.id });
  }
  showView("processing");
});

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
    showView(session ? "idle" : "signin");
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
  await pollStatus();
  _pollTimer = setInterval(pollStatus, 3000);
})();
