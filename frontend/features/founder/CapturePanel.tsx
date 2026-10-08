"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import { ApiError, captureFingerprint, founderApi, type Capture, type Project } from "@/lib/founder-api";
import { useWorkspaceData } from "./useWorkspaceData";

interface Readiness { provider_configured: boolean; manual_capture_enabled: boolean }
interface Props { projectId?: string; initialRequestId?: string; onQueued?: (id: string) => void }

export function CapturePanel({ projectId, initialRequestId, onQueued }: Props) {
  const { me, authedFetch } = useAuth();
  const readiness = useWorkspaceData<Readiness>("/capture-readiness");
  const projects = useWorkspaceData<Project[]>(projectId ? null : "/projects");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [requestId, setRequestId] = useState(initialRequestId ?? "");
  const [capture, setCapture] = useState<Capture | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const inputId = useId();
  const org = me?.org.id;
  useEffect(() => {
    if (!org || !requestId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let complete = false;
      try {
        const value = await founderApi(authedFetch, org).captureStatus(requestId, controller.signal);
        if (controller.signal.aborted) return;
        setCapture(value); setError("");
        complete = ["failed", "cancelled"].includes(value.status)
          || (value.status === "finalized" && ["done", "failed"].includes(value.processing_state ?? ""));
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && [403, 404].includes(reason.status)) {
          setCapture(null); complete = true;
        }
        setError(reason instanceof Error ? reason.message : "Status unavailable");
      }
      if (!controller.signal.aborted && !complete) timer = setTimeout(() => { void poll(); }, 5000);
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [org, requestId, authedFetch]);
  async function start() {
    if (!org || pending.current) return;
    const input = { meeting_url: url, title, project_id: projectId ?? (selectedProject || null) };
    const fingerprint = captureFingerprint(input);
    const key = intent.current?.fingerprint === fingerprint ? intent.current.key : crypto.randomUUID();
    intent.current = { fingerprint, key }; pending.current = true;
    setBusy(true); setError("");
    try {
      const value = await founderApi(authedFetch, org).startCapture(input, key);
      setCapture(value); setRequestId(value.id);
      setUrl(""); setTitle(""); intent.current = null;
      onQueued?.(value.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to queue capture"); }
    finally { pending.current = false; setBusy(false); }
  }
  async function stop() {
    if (!org || !capture || pending.current) return;
    pending.current = true; setBusy(true);
    try { setCapture(await founderApi(authedFetch, org).stopCapture(capture.id)); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to request stop"); }
    finally { pending.current = false; setBusy(false); }
  }
  const terminal = capture && ["failed", "cancelled", "finalized"].includes(capture.status);
  const locked = busy || !!(requestId && !terminal);
  const target = projectId || selectedProject;
  return <section className="founder-card founder-shell"><h2>Capture a meeting happening now</h2>
    <p>No calendar event or calendar connection needed. Paste a Google Meet, Zoom or Teams invitation link.</p>
    <p>The notetaker joins as a participant; the host may need to admit it. Capture starts only after provider confirmation. Tell participants about transcription before starting.</p>
    <form onSubmit={(event) => { event.preventDefault(); void start(); }}>
      <label htmlFor={`${inputId}-url`}>Meeting invitation link</label>
      <input id={`${inputId}-url`} type="url" required maxLength={4096} placeholder="https://meet.google.com/xxx-xxxx-xxx" value={url} onChange={(e) => setUrl(e.target.value)} disabled={locked} />
      <label htmlFor={`${inputId}-title`}>Title (optional)</label>
      <input id={`${inputId}-title`} maxLength={255} value={title} onChange={(e) => setTitle(e.target.value)} disabled={locked} />
      {!projectId && <label>Save to project<select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)} disabled={locked}>
        <option value="">Unassigned — private to you</option>
        {projects.data?.filter((p) => p.status === "active" && p.role !== "viewer").map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}
      </select></label>}
      <p>{target ? "This meeting’s transcript and summary will be shared with the selected project’s members." : "Saved privately in Unassigned. You can assign it to a project later."}</p>
      <button type="submit" disabled={locked || !url.trim() || !readiness.data?.provider_configured || !readiness.data?.manual_capture_enabled}>{busy ? "Working…" : "Capture now"}</button>
    </form>
    {readiness.data && !readiness.data.provider_configured && <p role="status">Capture provider not configured. Ask your workspace operator to configure it.</p>}
    {readiness.data && !readiness.data.manual_capture_enabled && <p role="status">Capture is off or disclosure is not acknowledged. <Link href="/onboarding">Review capture preferences</Link>.</p>}
    {[readiness.error, projects.error].filter(Boolean).map((message) => <p role="alert" key={message}>{message}</p>)}
    {requestId && !capture && <p role="status">Restoring capture status… <Link href="/capture">Start a different capture</Link></p>}
    {capture && <div role="status"><h3>{capture.title || "Instant meeting"}</h3>
      <p>Request: {capture.status} · Provider: {capture.provider_state ?? "not contacted yet"}</p>
      <p>Last transcript received: {capture.last_transcript_at ? new Date(capture.last_transcript_at).toLocaleString() : "none yet"}</p>
      {capture.is_stale && <p>Provider contact is stale. Capture is not currently confirmed.</p>}
      {capture.error_code && <p>{capture.error_code}</p>}
      {capture.stop_state && capture.stop_state !== "not_requested" && <p>Stop: {capture.stop_state}. Departure is confirmed only when the provider confirms it.</p>}
      {!terminal && <button disabled={busy} onClick={() => { void stop(); }}>Stop capture</button>}
      {capture.capture_session_id ? <Link href={`/meetings/${encodeURIComponent(capture.capture_session_id)}/report`}>{capture.report_ready ? "Open report" : `View processing (${capture.processing_state ?? "pending"})`}</Link>
        : <p>{capture.status === "finalized" ? "Waiting for transcript processing." : "Report available after the meeting ends and its transcript is processed."}</p>}
      <p><Link href={`/capture?request=${encodeURIComponent(capture.id)}`}>Reopen this capture after refresh</Link> · <Link href="/meetings">Meeting history</Link></p>
    </div>}
    {error && <p role="alert" className="founder-error">{error} <Link href="/capture">View recent captures</Link></p>}
    <p className="founder-muted">Current live lane: transcript capture. Screen/video evidence and universal admission are not promised.</p>
  </section>;
}
