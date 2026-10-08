"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import { apiJson, workspacePath } from "@/lib/founder-api";
import { useWorkspaceData } from "./useWorkspaceData";

interface Readiness { provider_configured: boolean; automatic_capture_enabled: boolean; live_join_verified: boolean }
interface Capture { id: string; meeting_id: string; status: string; provider_state?: string; stop_state?: string; error_code?: string; is_stale?: boolean; last_transcript_at?: string }

export function CapturePanel({ projectId }: { projectId?: string }) {
  const { me, authedFetch } = useAuth();
  const readiness = useWorkspaceData<Readiness>("/capture-readiness");
  const [url, setUrl] = useState("");
  const [capture, setCapture] = useState<Capture | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<{ url: string; key: string } | null>(null);
  const org = me?.org.id;
  useEffect(() => {
    if (!org || !capture?.id) return;
    const controller = new AbortController();
    const path = workspacePath(org, `/capture-requests/${encodeURIComponent(capture.id)}`);
    const poll = () => apiJson<Capture>(authedFetch, path, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) { setCapture(value); setError(""); } })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Status unavailable"); });
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [org, capture?.id, authedFetch]);
  async function start() {
    if (!org || busy) return;
    const key = intent?.url === url ? intent.key : crypto.randomUUID();
    setIntent({ url, key }); setBusy(true); setError("");
    try {
      setCapture(await apiJson<Capture>(authedFetch, workspacePath(org, "/captures"), {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ meeting_url: url, project_id: projectId ?? null }),
      }));
      setUrl(""); setIntent(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to queue capture"); }
    finally { setBusy(false); }
  }
  async function stop() {
    if (!org || !capture || busy) return;
    setBusy(true);
    try { setCapture(await apiJson<Capture>(authedFetch, workspacePath(org, `/capture-requests/${capture.id}/stop`), { method: "POST" })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to request stop"); }
    finally { setBusy(false); }
  }
  const terminal = capture && ["failed", "cancelled", "finalized"].includes(capture.status);
  return <section className="founder-card"><h2>Capture a meeting</h2>
    <p>Meet, Zoom or Teams. A queued request is not proof of recording. The host may need to admit the notetaker.</p>
    {projectId && <p>Its transcript and summary will be shared with this project’s members.</p>}
    <label htmlFor="capture-url">Meeting invitation link</label>
    <input id="capture-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy || !!(capture && !terminal)} />
    <button onClick={() => { void start(); }} disabled={busy || !url.trim() || !readiness.data?.provider_configured || !!(capture && !terminal)}>Capture now</button>
    {!readiness.data?.provider_configured && <p role="status">Capture provider not configured. Ask your workspace operator to configure it.</p>}
    {readiness.error && <p role="alert">{readiness.error}</p>}
    {capture && <div role="status"><p>Request: {capture.status} · Provider: {capture.provider_state ?? "not contacted yet"}</p>
      <p>Last transcript received: {capture.last_transcript_at ? new Date(capture.last_transcript_at).toLocaleString() : "none yet"}</p>
      {capture.is_stale && <p>Provider contact is stale. Capture is not currently confirmed.</p>}
      {capture.error_code && <p>{capture.error_code}</p>}
      {capture.stop_state && capture.stop_state !== "not_requested" && <p>Stop: {capture.stop_state}. Departure is confirmed only when the provider confirms it.</p>}
      {!terminal && <button disabled={busy} onClick={() => { void stop(); }}>Stop capture</button>}
      <Link href={`/meetings/${capture.meeting_id}/report`}>Open meeting and processing result</Link>
    </div>}
    {error && <p role="alert" className="founder-error">{error}</p>}
  </section>;
}
