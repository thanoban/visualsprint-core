/**
 * Popup — sign in/out, recording status, stop button.
 * Audio capture is initiated by the service worker's chrome.action.onClicked
 * handler (when a meeting is pending, the popup is disabled for that tab so
 * clicking the icon fires onClicked instead of opening this popup).
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

function showView(name) {
  for (const [k, el] of Object.entries(views)) {
    el.classList.toggle("hidden", k !== name);
  }
}

// ─── Sign in ─────────────────────────────────────────────────────────────────
$signinBtn.addEventListener("click", async () => {
  const email    = $email.value.trim();
  const password = $password.value;
  if (!email || !password) { showError("Enter your email and password."); return; }
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
    await setStoredSession({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Math.floor(Date.now() / 1000) + data.expires_in,
    });
    // Eagerly cache org_id so the SW doesn't have to fetch it on first capture.
    _cacheOrgId(data.access_token);
    await pollStatus();
    _pollTimer = setInterval(pollStatus, 3000);
  } catch {
    showError("Network error — is the backend reachable?");
  } finally {
    $signinBtn.disabled = false;
    $signinBtn.textContent = "Sign in";
  }
});

async function _cacheOrgId(accessToken) {
  const { VS_API_BASE_URL } = await import("../lib/config.js");
  try {
    const resp = await fetch(`${VS_API_BASE_URL}/api/v1/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const orgId = data.org?.id;
    if (orgId) chrome.storage.local.set({ vs_org_id: orgId });
  } catch { /* SW will fetch it lazily on first capture */ }
}

function showError(msg) {
  $signinErr.textContent = msg;
  $signinErr.classList.remove("hidden");
}

// ─── Sign out ─────────────────────────────────────────────────────────────────
$signoutBtn.addEventListener("click", async () => {
  await clearStoredSession();
  await chrome.storage.local.remove("vs_org_id");
  clearInterval(_pollTimer);
  showView("signin");
});

// ─── Stop recording ───────────────────────────────────────────────────────────
$stopBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.runtime.sendMessage({ type: "STOP_REQUESTED", tabId: tab.id });
  showView("processing");
});

// ─── Status polling ───────────────────────────────────────────────────────────
let _pollTimer = null;

async function pollStatus() {
  const r = await chrome.storage.session.get("vs_active_recordings");
  const recordings = r.vs_active_recordings ?? {};
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const rec = tab ? recordings[tab.id] : null;

  if (rec && !rec.finalized) {
    $elapsed.textContent = _fmt(Math.floor((Date.now() - rec.startedAt) / 1000));
    $chunks.textContent  = rec.chunkSeq ?? 0;
    $frames.textContent  = rec.keyframeSeq ?? 0;
    $title.textContent   = rec.title ?? "";
    showView("recording");
  } else if (rec?.finalized) {
    showView("processing");
  } else {
    showView("idle");
  }
}

function _fmt(s) {
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  const session = await getStoredSession();
  if (!session) { showView("signin"); return; }
  await pollStatus();
  _pollTimer = setInterval(pollStatus, 3000);
})();
