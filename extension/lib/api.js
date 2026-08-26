/**
 * Companion API client — wraps the four backend companion endpoints.
 * All calls go from the background service worker (which has host_permissions
 * for the backend origin, bypassing CORS entirely).
 */
import { VS_API_BASE_URL } from "./config.js";
import { getAuthHeaders } from "./auth.js";

async function _apiFetch(path, init = {}) {
  const headers = await getAuthHeaders();
  if (!headers) throw new Error("not signed in");
  const resp = await fetch(`${VS_API_BASE_URL}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${text}`);
  }
  return resp.json();
}

export async function createSession(orgId, { title, meetingUrl, platform }) {
  return _apiFetch(`/api/v1/orgs/${orgId}/companion/sessions`, {
    method: "POST",
    body: JSON.stringify({ title, meeting_url: meetingUrl, platform }),
  });
}

export async function uploadChunk(orgId, sessionId, seq, webmBytes) {
  const headers = await getAuthHeaders();
  if (!headers) throw new Error("not signed in");
  const form = new FormData();
  form.append("seq", String(seq));
  form.append("data", new Blob([webmBytes], { type: "audio/webm" }), "chunk.webm");
  const resp = await fetch(
    `${VS_API_BASE_URL}/api/v1/orgs/${orgId}/companion/sessions/${sessionId}/chunks`,
    { method: "POST", headers: { Authorization: headers.Authorization }, body: form }
  );
  if (!resp.ok) throw new Error(`chunk upload ${resp.status}`);
  return resp.json();
}

export async function uploadKeyframe(orgId, sessionId, seq, timestampS, jpegBytes) {
  const headers = await getAuthHeaders();
  if (!headers) throw new Error("not signed in");
  const form = new FormData();
  form.append("seq", String(seq));
  form.append("timestamp_s", String(timestampS));
  form.append("data", new Blob([jpegBytes], { type: "image/jpeg" }), "frame.jpg");
  const resp = await fetch(
    `${VS_API_BASE_URL}/api/v1/orgs/${orgId}/companion/sessions/${sessionId}/keyframes`,
    { method: "POST", headers: { Authorization: headers.Authorization }, body: form }
  );
  if (!resp.ok) throw new Error(`keyframe upload ${resp.status}`);
  return resp.json();
}

export async function finalizeSession(orgId, sessionId, totalChunks, roster) {
  return _apiFetch(
    `/api/v1/orgs/${orgId}/companion/sessions/${sessionId}/finalize`,
    {
      method: "POST",
      body: JSON.stringify({ total_chunks: totalChunks, roster }),
    }
  );
}
