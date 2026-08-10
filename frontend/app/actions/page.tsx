"use client";

// Ported from the Claude Design project "Visualsprint core development" ->
// Actions.dc.html. AppSidebar isn't re-embedded (see report/page.tsx's
// note). The mockup's "Based on: <evidence lines>" box has no backing field
// on ProposedActionOut (id/kind/title/body/target/status/...), so it's
// replaced with the real `target` dict the API actually returns -- same
// data the pre-redesign page already surfaced, not fabricated evidence.
// "History" is a real fetch (no status filter, split client-side) rather
// than the mockup's hardcoded past-actions array.

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type { ProposedActionOut } from "@/lib/types";

const sans = "'IBM Plex Sans', sans-serif";
const serif = "'Source Serif 4', serif";
const mono = "'IBM Plex Mono', monospace";

const KIND_LABELS: Record<string, string> = {
  email_draft: "Email draft",
  channel_recap: "Channel recap",
  task_create: "Task",
  calendar_followup: "Calendar follow-up",
  escalation: "Escalation",
  reminder: "Reminder",
};

function statusLabel(status: ProposedActionOut["status"]): string {
  return { pending_approval: "Pending", approved: "Approved", rejected: "Rejected", executed: "Executed", failed: "Failed" }[status] ?? status;
}
function statusIsPositive(status: ProposedActionOut["status"]): boolean {
  return status === "approved" || status === "executed";
}

function PendingCard({
  action,
  onResolved,
}: {
  action: ProposedActionOut;
  onResolved: (id: string, updated: ProposedActionOut | null) => void;
}) {
  const { authedFetch } = useAuth();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProposedActionOut | null>(null);

  async function handleApprove() {
    setBusy("approve");
    setError(null);
    try {
      const res = await authedFetch(`/api/v1/actions/${action.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
      }
      const updated = (await res.json()) as ProposedActionOut;
      setResult(updated);
      onResolved(action.id, updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve.");
    } finally {
      setBusy(null);
    }
  }

  async function handleReject() {
    setBusy("reject");
    setError(null);
    try {
      const res = await authedFetch(`/api/v1/actions/${action.id}/reject`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
      }
      onResolved(action.id, null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject.");
    } finally {
      setBusy(null);
    }
  }

  const targetLines = Object.entries(action.target).map(([k, v]) => `${k}: ${v}`);

  return (
    <article style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "22px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontFamily: mono,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.02em",
              textTransform: "uppercase",
              color: "var(--accent-strong)",
              background: "var(--accent-bg)",
              padding: "3px 9px",
              borderRadius: 4,
            }}
          >
            {KIND_LABELS[action.kind] ?? action.kind}
          </span>
          <p style={{ fontFamily: serif, fontSize: 17, color: "var(--text)", margin: "12px 0 6px" }}>{action.title}</p>
          <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--text-muted)", margin: 0, whiteSpace: "pre-wrap" }}>{action.body}</p>
          {targetLines.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              <p style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.02em", margin: "0 0 6px" }}>
                Target
              </p>
              {targetLines.map((line) => (
                <p key={line} style={{ fontFamily: mono, fontSize: 12, color: "var(--text-muted)", margin: "0 0 4px" }}>
                  {line}
                </p>
              ))}
            </div>
          )}
          {result && (
            <div
              style={{
                marginTop: 14,
                borderRadius: 6,
                padding: "8px 12px",
                fontSize: 13,
                background: result.status === "executed" ? "var(--accent-bg)" : "var(--evidence-bg)",
                color: result.status === "executed" ? "var(--accent-strong)" : "var(--evidence)",
              }}
            >
              {result.status === "executed" ? (
                <>
                  Executed.{" "}
                  {result.external_url && (
                    <a href={result.external_url} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                      View →
                    </a>
                  )}
                </>
              ) : (
                <>Approved, but execution failed: {result.error}</>
              )}
            </div>
          )}
          {error && <p style={{ fontSize: 12.5, color: "var(--gap)", marginTop: 8 }}>{error}</p>}
        </div>
        {!result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
            <button
              type="button"
              onClick={handleApprove}
              disabled={busy !== null}
              style={{ fontFamily: sans, fontSize: 13, fontWeight: 600, color: "#fff", background: "var(--accent-strong)", border: "none", padding: "8px 18px", borderRadius: 7, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={busy !== null}
              style={{ fontFamily: sans, fontSize: 13, fontWeight: 600, color: "var(--text-muted)", background: "transparent", border: "1px solid var(--border-strong)", padding: "8px 18px", borderRadius: 7, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
            >
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

export default function ActionsPage() {
  const { me, authedFetch } = useAuth();
  const [actions, setActions] = useState<ProposedActionOut[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    authedFetch(`/api/v1/orgs/${me.org.id}/actions`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<ProposedActionOut[]>;
      })
      .then(setActions)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load actions"))
      .finally(() => setLoading(false));
  }, [me, authedFetch]);

  function handleResolved(actionId: string, updated: ProposedActionOut | null) {
    setActions((prev) => {
      if (!prev) return prev;
      if (updated === null) return prev.filter((a) => a.id !== actionId);
      return prev.map((a) => (a.id === actionId ? updated : a));
    });
  }

  if (loading) {
    return <p style={{ fontSize: 14, color: "var(--text-muted)", padding: 32 }}>Loading proposed actions…</p>;
  }

  if (error || !actions) {
    return (
      <p style={{ margin: 32, borderRadius: 6, background: "var(--gap-bg)", border: "1px solid var(--gap)", padding: "8px 12px", fontSize: 14, color: "var(--gap)" }}>
        {error ?? "Failed to load."}
      </p>
    );
  }

  const pending = actions.filter((a) => a.status === "pending_approval");
  const history = actions
    .filter((a) => a.status !== "pending_approval")
    .sort((a, b) => (b.approved_at ?? "").localeCompare(a.approved_at ?? ""));

  return (
    <div>
      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--border)" }}>
        <p style={{ fontFamily: serif, fontSize: 20, color: "var(--text)", margin: 0 }}>Actions</p>
        <p style={{ fontSize: 13, color: "var(--text-faint)", margin: "6px 0 0" }}>
          Proposed by verified knowledge — nothing sends until you approve it.
        </p>
      </header>

      <main style={{ padding: "28px 32px 64px", maxWidth: 820 }}>
        <section>
          <p style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--text-faint)", margin: "0 0 14px" }}>
            Awaiting your approval ({pending.length})
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {pending.length === 0 ? (
              <p style={{ fontSize: 14, color: "var(--text-faint)", padding: "20px 0" }}>
                All caught up — no actions waiting on you.
              </p>
            ) : (
              pending.map((a) => <PendingCard key={a.id} action={a} onResolved={handleResolved} />)
            )}
          </div>
        </section>

        {history.length > 0 && (
          <section style={{ marginTop: 32 }}>
            <p style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--text-faint)", margin: "0 0 14px" }}>
              History
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {history.map((h) => (
                <div
                  key={h.id}
                  style={{ display: "grid", gridTemplateColumns: "130px 1fr 90px", alignItems: "center", gap: 14, padding: "12px 4px", borderBottom: "1px solid var(--border)" }}
                >
                  <span
                    style={{
                      fontFamily: mono,
                      fontSize: 10.5,
                      fontWeight: 600,
                      color: "var(--text-faint)",
                      border: "1px solid var(--border-strong)",
                      padding: "2px 7px",
                      borderRadius: 4,
                      width: "fit-content",
                    }}
                  >
                    {KIND_LABELS[h.kind] ?? h.kind}
                  </span>
                  <span style={{ fontSize: 13, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {h.title}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "3px 9px",
                      borderRadius: 20,
                      width: "fit-content",
                      justifySelf: "end",
                      color: statusIsPositive(h.status) ? "var(--accent-strong)" : "var(--gap)",
                      background: statusIsPositive(h.status) ? "var(--accent-bg)" : "var(--gap-bg)",
                    }}
                  >
                    {statusLabel(h.status)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
