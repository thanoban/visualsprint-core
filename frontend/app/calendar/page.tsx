"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import { apiJson, workspacePath } from "@/lib/founder-api";
import { useWorkspaceData } from "@/features/founder/useWorkspaceData";
import { CapturePanel } from "@/features/founder/CapturePanel";

interface Occurrence { id: string; title: string; start_time: string; platform: string | null; revision: number; capture_override: string | null; capture_error: string | null }
interface Connection { id: string; provider: string; account_email: string; owner_verified: boolean; watch_healthy: boolean }
export default function CalendarPage() {
  const { me, authedFetch } = useAuth();
  const events = useWorkspaceData<Occurrence[]>("/occurrences");
  const connections = useWorkspaceData<Connection[]>("/connections");
  const readiness = useWorkspaceData<{ automatic_capture_enabled: boolean }>("/capture-readiness");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function override(event: Occurrence, value: string) {
    if (!me || busy) return;
    setBusy(true); setError("");
    try { await apiJson(authedFetch, workspacePath(me.org.id, `/occurrences/${event.id}/capture-override`), {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capture_override: value || null, version: event.revision }),
    }); events.refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to change capture"); }
    finally { setBusy(false); }
  }
  return <main className="founder-shell"><h1>Calendar and capture</h1>
    <p>Only calendars connected by your signed-in account appear here. Automatic capture requires workspace policy, disclosure and a configured provider.</p>
    <p>Automatic capture: {readiness.data?.automatic_capture_enabled ? "policy enabled" : "not enabled"}. <Link href="/onboarding">Capture preferences</Link> · <Link href="/settings/connections">Connect or reconnect a calendar</Link></p>
    {connections.data?.map((c) => <p key={c.id}>{c.provider}: {c.account_email} · {c.owner_verified ? "owner verified" : "reconnect required"} · {c.watch_healthy ? "notifications active" : "periodic reconciliation required"}</p>)}
    {connections.data?.length === 0 && <p>No calendar connected for your account.</p>}
    <CapturePanel key={`${me?.user.id}:${me?.org.id}`} />
    <h2>Next seven days</h2><button onClick={events.refresh}>Refresh calendar status</button>
    {!events.data && !events.error && <p role="status">Loading events…</p>}
    {[events.error, connections.error, readiness.error, error].filter(Boolean).map((message, index) => <p key={index} role="alert" className="founder-error">{message}</p>)}
    {events.data?.length === 0 && <p>No synchronized upcoming meetings. Calendar changes appear after the scheduler reconciles them.</p>}
    {events.data?.map((event) => <article className="founder-card" key={event.id}><h3>{event.title || "Untitled event"}</h3>
      <p>{new Date(event.start_time).toLocaleString()} · {event.platform ?? "no supported meeting link"}</p>
      <label htmlFor={`override-${event.id}`}>Capture policy</label>
      <select id={`override-${event.id}`} value={event.capture_override ?? ""} disabled={busy} onChange={(e) => { void override(event, e.target.value); }}>
        <option value="">Workspace default</option><option value="on">Capture this event</option><option value="off">Do not capture</option>
      </select>{event.capture_error && <p role="status">{event.capture_error}</p>}
    </article>)}
  </main>;
}
