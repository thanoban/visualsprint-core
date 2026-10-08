"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import type { CapturePage } from "@/lib/founder-api";
import { CapturePanel } from "@/features/founder/CapturePanel";
import { useWorkspaceData } from "@/features/founder/useWorkspaceData";

function CaptureHub() {
  const { me } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const requestId = params.get("request") ?? "";
  const [cursor, setCursor] = useState<string | null>(null);
  const captures = useWorkspaceData<CapturePage>(`/capture-requests?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  return <main className="founder-shell"><h1>Capture now</h1>
    <p>Impromptu customer call? Use its invitation link. Calendar sync is optional and only needed for scheduling automatic capture.</p>
    <CapturePanel key={`${me?.user.id}:${me?.org.id}:${requestId}`} initialRequestId={requestId} onQueued={(id) => {
      router.replace(`/capture?request=${encodeURIComponent(id)}`); captures.refresh();
    }} />
    <h2>Your recent capture requests</h2><button onClick={captures.refresh}>Refresh requests</button>
    {captures.error && <p role="alert">{captures.error}</p>}
    {!captures.data && !captures.error && <p role="status">Loading…</p>}
    {captures.data?.items.length === 0 && <p>No captures yet. Paste a link above to start.</p>}
    {captures.data?.items.map((capture) => <article className="founder-card" key={capture.id}>
      <h3>{capture.title || "Untitled meeting"}</h3>
      <p>{capture.platform ?? "Meeting"} · {capture.created_at ? new Date(capture.created_at).toLocaleString() : ""} · {capture.status}</p>
      <Link href={`/capture?request=${encodeURIComponent(capture.id)}`}>Open capture status / stop</Link>
      {capture.capture_session_id && <> · <Link href={`/meetings/${encodeURIComponent(capture.capture_session_id)}/report`}>{capture.report_ready ? "Open report" : "View processing"}</Link></>}
    </article>)}
    {cursor && <button onClick={() => setCursor(null)}>Newest requests</button>}
    {captures.data?.next_cursor && <button onClick={() => setCursor(captures.data!.next_cursor)}>Older requests</button>}
  </main>;
}

export default function CaptureNowPage() {
  return <Suspense fallback={<p role="status">Loading capture…</p>}><CaptureHub /></Suspense>;
}
