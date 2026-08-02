"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/config";
import type { ProposedActionOut } from "@/lib/types";

/** No auth/org-selection yet -- resolve the dev-convenience "default" org
 * name to its real id, same pattern as app/glossary/page.tsx and
 * app/chat/page.tsx (see those for why the literal string "default" is not
 * usable directly as an org_id). */
async function resolveDefaultOrgId(): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/v1/orgs/default`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const org = (await res.json()) as { id: string; name: string };
  return org.id;
}

async function fetchActions(orgId: string): Promise<ProposedActionOut[]> {
  const res = await fetch(`${API_BASE_URL}/api/v1/orgs/${orgId}/actions?status=pending_approval`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as ProposedActionOut[];
}

const KIND_LABELS: Record<string, string> = {
  email_draft: "Email draft",
  channel_recap: "Channel recap",
  task_create: "Task",
  calendar_followup: "Calendar follow-up",
  escalation: "Escalation",
  reminder: "Reminder",
};

function ActionCard({
  action,
  onResolved,
}: {
  action: ProposedActionOut;
  onResolved: (id: string, updated: ProposedActionOut | null) => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProposedActionOut | null>(null);

  async function handleApprove() {
    setBusy("approve");
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/actions/${action.id}/approve`, {
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
      const res = await fetch(`${API_BASE_URL}/api/v1/actions/${action.id}/reject`, {
        method: "POST",
      });
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

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            {KIND_LABELS[action.kind] ?? action.kind}
          </span>
          <p className="mt-1.5 text-sm font-medium text-slate-900">{action.title}</p>
        </div>
      </div>

      <p className="text-sm text-slate-600 whitespace-pre-wrap">{action.body}</p>

      {Object.keys(action.target).length > 0 && (
        <p className="text-xs text-slate-400">
          {Object.entries(action.target)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ")}
        </p>
      )}

      {result ? (
        <div
          className={`rounded-md px-3 py-2 text-sm ${
            result.status === "executed"
              ? "bg-green-50 border border-green-200 text-green-800"
              : "bg-amber-50 border border-amber-200 text-amber-800"
          }`}
        >
          {result.status === "executed" ? (
            <>
              Executed.{" "}
              {result.external_url && (
                <a href={result.external_url} target="_blank" rel="noreferrer" className="underline">
                  View →
                </a>
              )}
            </>
          ) : (
            <>Approved, but execution failed: {result.error}</>
          )}
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleApprove}
            disabled={busy !== null}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={handleReject}
            disabled={busy !== null}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-700">{error}</p>}
    </li>
  );
}

export default function ActionsPage() {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [actions, setActions] = useState<ProposedActionOut[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    resolveDefaultOrgId()
      .then((id) => {
        setOrgId(id);
        return fetchActions(id);
      })
      .then(setActions)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load actions"))
      .finally(() => setLoading(false));
  }, []);

  function handleResolved(actionId: string, updated: ProposedActionOut | null) {
    if (updated === null || updated.status !== "pending_approval") {
      // Approved (executed or failed) or rejected -- either way it leaves
      // the pending queue. Keep an approved-but-failed card visible for a
      // moment via its own inline result state rather than yanking it, but
      // remove it from this list's backing data so a refresh doesn't re-show it.
      setActions((prev) => (prev ? prev.filter((a) => a.id !== actionId) : prev));
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading proposed actions…</p>;
  }

  if (error || !actions) {
    return (
      <p className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
        {error ?? "Failed to load."}
      </p>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Proposed actions</h1>
        <p className="mt-1 text-sm text-slate-600">
          Drafted from verified knowledge — nothing here has run yet. Approve to execute, or reject to
          discard.
        </p>
      </div>

      {actions.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          No actions awaiting approval.
        </p>
      ) : (
        <ul className="space-y-3">
          {actions.map((a) => (
            <ActionCard key={a.id} action={a} onResolved={handleResolved} />
          ))}
        </ul>
      )}
    </div>
  );
}
