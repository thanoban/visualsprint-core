"use client";

import Link from "next/link";
import type { Memory } from "@/lib/founder-api";
import { useWorkspaceData } from "./useWorkspaceData";

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
}
export function ScopeMemory({ kind, id }: { kind: "projects" | "customers"; id: string }) {
  const memory = useWorkspaceData<Memory>(`/${kind}/${encodeURIComponent(id)}/memory`);
  return <section className="founder-card" aria-label="Supported meeting context"><h2>Meeting context</h2>
    {memory.error && <p role="alert" className="founder-error">{memory.error}</p>}
    {!memory.data && !memory.error && <p role="status">Loading current context…</p>}
    {memory.data && <>
      <p>{typeof memory.data.structured_summary.context_summary === "string" ? memory.data.structured_summary.context_summary : "No supported context available."}</p>
      <p className="founder-muted">Based only on {memory.data.source_meeting_ids.length} accessible meetings. Provider labels are not verified person identities.</p>
      {(["decisions", "commitments", "open_questions", "blockers"] as const).map((bucket) => <div key={bucket}>
        <h3>{bucket.replaceAll("_", " ")}</h3>
        {records(memory.data!.structured_summary[bucket]).length === 0 && <p className="founder-muted">No supported items.</p>}
        <ul>{records(memory.data!.structured_summary[bucket]).map((item, index) => <li key={typeof item.id === "string" ? item.id : index}>
          <p>{typeof item.statement === "string" ? item.statement : "Unavailable statement"}</p>
          {item.coverage_gap === true && <span>Partial capture · </span>}
          {typeof item.capture_session_id === "string" && <Link href={`/meetings/${encodeURIComponent(item.capture_session_id)}/report?item=${encodeURIComponent(String(item.id ?? ""))}`}>Source meeting</Link>}
        </li>)}</ul>
      </div>)}
    </>}
  </section>;
}
