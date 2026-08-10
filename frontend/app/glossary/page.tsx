"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type { GlossaryTermOut } from "@/lib/types";

export default function GlossaryPage() {
  const { me, authedFetch } = useAuth();
  const [terms, setTerms] = useState<GlossaryTermOut[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTerm, setNewTerm] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!me) return;
    authedFetch(`/api/v1/orgs/${me.org.id}/glossary`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<GlossaryTermOut[]>;
      })
      .then(setTerms)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load glossary"))
      .finally(() => setLoading(false));
  }, [me, authedFetch]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const term = newTerm.trim();
    if (!term || adding || !me) return;
    setAdding(true);
    setError(null);
    try {
      const res = await authedFetch(`/api/v1/orgs/${me.org.id}/glossary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ term }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.detail ?? `${res.status} ${res.statusText}`);
      }
      const created = (await res.json()) as GlossaryTermOut;
      setTerms((prev) => (prev ? [created, ...prev] : [created]));
      setNewTerm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add term.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(termId: string) {
    if (!me) return;
    const prev = terms;
    setTerms((cur) => (cur ? cur.filter((t) => t.id !== termId) : cur));
    try {
      const res = await authedFetch(`/api/v1/orgs/${me.org.id}/glossary/${termId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      setTerms(prev); // roll back on failure
      setError(err instanceof Error ? err.message : "Failed to delete term.");
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Org glossary</h1>
        <p className="mt-1 text-sm text-slate-600">
          Ticket IDs, names, and technical terms the transcription repair pass should recognize —
          fixes made on a meeting&apos;s transcript can add terms here too.
        </p>
      </div>

      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="text"
          value={newTerm}
          onChange={(e) => setNewTerm(e.target.value)}
          placeholder="e.g. PAY-442, Udula Wickramasinghe, JWT"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <button
          type="submit"
          disabled={adding || !newTerm.trim() || !me}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {adding ? "Adding…" : "Add"}
        </button>
      </form>

      {error && (
        <p className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : terms && terms.length > 0 ? (
        <ul className="space-y-2">
          {terms.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-2.5"
            >
              <div>
                <span className="text-sm font-medium text-slate-900">{t.term}</span>
                {t.added_by && <span className="ml-2 text-xs text-slate-400">added by {t.added_by}</span>}
              </div>
              <button
                type="button"
                onClick={() => handleDelete(t.id)}
                className="text-xs font-medium text-slate-400 hover:text-red-600"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          No glossary terms yet.
        </p>
      )}
    </div>
  );
}
