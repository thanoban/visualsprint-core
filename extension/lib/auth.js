/**
 * Auth helpers for the background service worker.
 * Reads/refreshes the Supabase session stored in chrome.storage.local.
 * All backend API calls must go through getAuthHeaders() so the token is
 * always fresh (Supabase access tokens expire after 1 hour).
 */
import { VS_SUPABASE_URL, VS_SUPABASE_ANON_KEY } from "./config.js";

const STORAGE_KEY = "vs_supabase_session";
const REFRESH_MARGIN_S = 120; // refresh if token expires within 2 minutes

export async function getStoredSession() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? null;
}

export async function setStoredSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
}

export async function clearStoredSession() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

export async function getAuthHeaders() {
  let session = await getStoredSession();
  if (!session) return null;

  const expiresAt = session.expires_at ?? 0;
  const nowS = Math.floor(Date.now() / 1000);

  if (expiresAt - nowS < REFRESH_MARGIN_S) {
    const refreshed = await _refreshSession(session.refresh_token);
    if (refreshed) {
      session = refreshed;
    } else {
      await clearStoredSession();
      return null;
    }
  }

  return {
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
  };
}

async function _refreshSession(refreshToken) {
  try {
    const resp = await fetch(
      `${VS_SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: {
          apikey: VS_SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const newSession = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
    };
    await setStoredSession(newSession);
    return newSession;
  } catch {
    return null;
  }
}
