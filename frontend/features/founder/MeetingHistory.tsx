"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import { founderApi, type Meeting, type MeetingPage, type Project } from "@/lib/founder-api";
import { useWorkspaceData } from "./useWorkspaceData";

export function MeetingHistory({ scope = "", onChanged }: { scope?: string; onChanged?: () => void }) {
  const { me, authedFetch } = useAuth();
  const [cursor, setCursor] = useState<string | null>(null);
  const meetings = useWorkspaceData<MeetingPage>(`/meetings?limit=25${scope}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  const projects = useWorkspaceData<Project[]>("/projects");
  const [edit, setEditing] = useState<(Meeting & { actorId: string; workspaceId: string }) | null>(null);
  const editing = edit?.actorId === me?.user.id && edit?.workspaceId === me?.org.id ? edit : null;
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (editing) dialog.current?.showModal();
  }, [editing]);
  async function move() {
    if (!me || !editing) return;
    setPending(true); setError(null);
    try {
      const api = founderApi(authedFetch, me.org.id);
      if (target) await api.assignMeeting(editing, target);
      else await api.unassignMeeting(editing);
      setEditing(null); meetings.refresh(); onChanged?.();
    } catch (err) { setError(err instanceof Error ? err.message : "Assignment failed"); }
    finally { setPending(false); }
  }
  return <section aria-label="Meeting history">
    {meetings.error && <p className="founder-error" role="alert">{meetings.error} <button onClick={meetings.refresh}>Retry</button></p>}
    {!meetings.data && !meetings.error && <p role="status">Loading meeting history…</p>}
    {meetings.data?.items.length === 0 && <p className="founder-empty">No meetings in this scope yet. Capture a meeting or assign one from Unassigned.</p>}
    {meetings.data?.items.map((meeting) => <article className="founder-card" key={meeting.id}>
      <div className="founder-row">
        {meeting.capture_request_id && <Link href={`/capture?request=${encodeURIComponent(meeting.capture_request_id)}`}>Capture status</Link>}
        <div><h3>{meeting.title}</h3><p className="founder-muted">{meeting.platform} · {new Date(meeting.scheduled_start ?? meeting.created_at).toLocaleString()}</p></div>
        <span>{meeting.processing_state ?? meeting.capture_status ?? "Not captured"}</span>
      </div>
      <div className="founder-row">
        {meeting.capture_session_id && <Link href={`/meetings/${meeting.capture_session_id}/report`}>{meeting.report_ready ? "Open report" : "View processing"}</Link>}
        {!meeting.project_id && <span className="founder-muted">Unassigned · owner-private</span>}
        {meeting.can_move && me && <button onClick={() => { setEditing({ ...meeting, actorId: me.user.id, workspaceId: me.org.id }); setTarget(meeting.project_id ?? ""); setError(null); }}>Assign / move</button>}
      </div>
    </article>)}
    {meetings.data && <div className="founder-row">
      {cursor && <button onClick={() => setCursor(null)}>Newest meetings</button>}
      {meetings.data.next_cursor && <button onClick={() => setCursor(meetings.data!.next_cursor)}>Older meetings</button>}
    </div>}
    {editing && <dialog ref={dialog} className="founder-card" aria-labelledby="assignment-title" onCancel={(event) => { if (pending) event.preventDefault(); else setEditing(null); }}>
      <h3 id="assignment-title">Move “{editing.title}”</h3>
      <label>Project<select value={target} onChange={(event) => setTarget(event.target.value)} disabled={pending}>
        <option value="">Unassigned (only the meeting owner)</option>
        {projects.data?.filter((project) => project.status === "active" && project.role !== "viewer").map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <p>Assigning shares this meeting’s transcript and summary with the target project’s members. Moving removes it from the previous project’s history.</p>
      {projects.error && <p className="founder-error" role="alert">{projects.error}</p>}
      {error && <p className="founder-error" role="alert">{error} <button onClick={() => { setEditing(null); meetings.refresh(); }}>Reload current assignment</button></p>}
      <div className="founder-row"><button disabled={pending || !projects.data || target === (editing.project_id ?? "")} onClick={move}>{pending ? "Saving…" : "Confirm assignment"}</button><button disabled={pending} onClick={() => setEditing(null)}>Cancel</button></div>
    </dialog>}
  </section>;
}
