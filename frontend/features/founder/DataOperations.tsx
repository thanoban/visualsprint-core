"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import { apiJson, workspacePath } from "@/lib/founder-api";

interface Job { id: string; status: string; error: string | null; download_url?: string | null }

export function OperationReceipt({ workspace, kind, id }: { workspace: string; kind: "exports" | "deletions"; id: string }) {
  const { authedFetch } = useAuth();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const poll = () => apiJson<Job>(authedFetch, workspacePath(workspace, `/${kind}/${encodeURIComponent(id)}`), { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) { setJob(value); setError(""); } })
      .catch((reason: unknown) => { if (!controller.signal.aborted) { setJob(null); setError(reason instanceof Error ? reason.message : "Receipt unavailable"); } });
    void poll(); const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [workspace, kind, id, authedFetch]);
  async function download() {
    try {
      const response = await authedFetch(workspacePath(workspace, `/exports/${encodeURIComponent(id)}/download`));
      if (!response.ok) { const body: { detail?: string } = await response.json(); throw new Error(body.detail || "Download unavailable"); }
      const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `visualsprint-${id}.json`; anchor.click(); URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Download failed"); }
  }
  async function retry() {
    try { setJob(await apiJson<Job>(authedFetch, workspacePath(workspace, `/deletions/${encodeURIComponent(id)}/retry`), { method: "POST" })); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to retry cleanup"); }
  }
  return <article className="founder-card"><h3>{kind === "exports" ? "Export" : "Deletion"} receipt</h3>
    <p role="status">{job ? job.status : "Loading…"}</p><p>Job: {id}</p>
    {job?.error && <p role="status">{job.error}</p>}
    {kind === "exports" && job?.status === "done" && job.download_url && <button onClick={() => { void download(); }}>Download JSON</button>}
    {kind === "deletions" && <p>Content is hidden while cleanup runs. “Done” means verified configured primary-store cleanup, not immediate deletion from backups or third-party tasks already approved.</p>}
    {kind === "deletions" && job?.status === "failed" && <button onClick={() => { void retry(); }}>Retry accepted cleanup</button>}
    {error && <p className="founder-error" role="alert">{error}</p>}
  </article>;
}

export function DataOperations({ kind, id, name, canDelete }: { kind: "project" | "workspace"; id: string; name: string; canDelete: boolean }) {
  const { me, authedFetch } = useAuth();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [confirmation, setConfirmation] = useState("");
  const [receipt, setReceipt] = useState<{ kind: "exports" | "deletions"; id: string; workspace: string } | null>(null);
  const [intent, setIntent] = useState<{ operation: string; key: string } | null>(null);
  async function create(operation: "exports" | "deletions") {
    if (!me || busy) return;
    const key = intent?.operation === operation ? intent.key : crypto.randomUUID();
    setIntent({ operation, key }); setBusy(true); setError("");
    try { const result = await apiJson<Job>(authedFetch, workspacePath(me.org.id, `/${operation}`), {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ scope_kind: kind, scope_id: id }),
    }); setReceipt({ kind: operation, id: result.id, workspace: me.org.id }); setIntent(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to schedule operation"); }
    finally { setBusy(false); }
  }
  return <section className="founder-card"><h2>Export and deletion</h2>
    <p>Scope: {kind} “{name}”. Exports contain accessible transcripts and verified knowledge, no audio or video. Downloads expire after 24 hours and are rechecked against current source access.</p>
    <button disabled={busy || receipt?.kind === "deletions" || (kind === "workspace" && !canDelete)} onClick={() => { void create("exports"); }}>Create text export</button>
    {canDelete && <><p>Deletion is irreversible. It removes this scope’s meetings and derived data after capture stops and cleanup is verified. Export first if you need a copy.</p>
      <label htmlFor={`delete-${id}`}>Type DELETE to confirm deletion of “{name}”</label>
      <input id={`delete-${id}`} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={busy} />
      <button disabled={busy || confirmation !== "DELETE" || receipt?.kind === "deletions"} onClick={() => { void create("deletions"); }}>Delete {kind}</button></>}
    {error && <p role="alert" className="founder-error">{error}</p>}
    {receipt && <><Link href={`/operations?workspace=${encodeURIComponent(receipt.workspace)}&${receipt.kind}=${encodeURIComponent(receipt.id)}`}>Save this receipt link before leaving</Link><OperationReceipt {...receipt} /></>}
  </section>;
}
