"use client";

// Restyled to the Claude Design project "VisualSprint landing redesign" ->
// VisualSprint App.dc.html (Vocabulary screen, renamed from Glossary --
// route and API stay /glossary). Dropped the mockup's "kind" taxonomy
// (Person/Project/Ticket/Technical) and its filter tabs: GlossaryTermOut has
// no `kind` field and inventing a classifier here is out of scope. The
// "heard often, spelled unsurely" suggestions queue is deferred entirely --
// no backend query exists for it (glossary.py only does add/list/delete of
// terms a human already typed), and building one is a real scoped feature,
// not a restyle.

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type { GlossaryTermOut } from "@/lib/types";

const sans = "'Plus Jakarta Sans', sans-serif";
const mono = "'IBM Plex Mono', monospace";

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
    <div>
      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--border)" }}>
        <p style={{ fontFamily: sans, fontWeight: 800, fontSize: 19, letterSpacing: "-0.02em", color: "var(--text)", margin: 0 }}>
          Vocabulary
        </p>
        <p style={{ fontSize: 13, color: "var(--faint)", margin: "6px 0 0", maxWidth: 620 }}>
          Ticket IDs, names, and technical terms the transcription repair pass should recognize —
          fixes made on a meeting&apos;s transcript can add terms here too.
        </p>
      </header>

      <main style={{ padding: "28px 32px 64px", maxWidth: 880 }}>
        <section style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 18, padding: "20px 22px", marginBottom: 20 }}>
          <form onSubmit={handleAdd} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label
              style={{
                flex: "1 1 260px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "var(--soft)",
                border: "1px solid var(--border)",
                borderRadius: 999,
                padding: "11px 18px",
              }}
            >
              <span style={{ color: "var(--faint)", fontSize: 13 }}>+</span>
              <input
                type="text"
                value={newTerm}
                onChange={(e) => setNewTerm(e.target.value)}
                placeholder="e.g. PAY-442, Udula Wickramasinghe, pgvector"
                style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontFamily: sans, fontSize: 13.5, color: "var(--text)" }}
              />
            </label>
            <button
              type="submit"
              disabled={adding || !newTerm.trim() || !me}
              style={{
                fontFamily: sans,
                fontSize: 13.5,
                fontWeight: 700,
                color: "#fff",
                background: "var(--blue)",
                border: "none",
                borderRadius: 999,
                padding: "12px 24px",
                cursor: adding ? "default" : "pointer",
                opacity: adding ? 0.7 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {adding ? "Adding…" : "Add word"}
            </button>
          </form>
        </section>

        {error && (
          <p style={{ borderRadius: 8, background: "var(--red-soft)", border: "1px solid var(--red)", padding: "8px 12px", fontSize: 13, color: "var(--red)", marginBottom: 16 }}>
            {error}
          </p>
        )}

        {loading ? (
          <p style={{ fontSize: 14, color: "var(--faint)" }}>Loading…</p>
        ) : terms && terms.length > 0 ? (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 18, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
              <p style={{ fontSize: 14.5, fontWeight: 700, margin: 0 }}>
                Your words{" "}
                <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: "var(--faint)" }}>{terms.length}</span>
              </p>
            </div>
            {terms.map((t) => (
              <div
                key={t.id}
                style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", padding: "14px 20px", borderBottom: "1px solid var(--border)" }}
              >
                <span style={{ flex: "1 1 200px", minWidth: 0, fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{t.term}</span>
                {t.added_by && (
                  <span style={{ fontFamily: mono, fontSize: 11, color: "var(--faint)" }}>added by {t.added_by}</span>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(t.id)}
                  style={{
                    fontFamily: sans,
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: "var(--faint)",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    padding: "6px 4px",
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ borderRadius: 12, border: "1px solid var(--border)", background: "var(--soft)", padding: "12px 16px", fontSize: 14, color: "var(--muted)" }}>
            No vocabulary terms yet.
          </p>
        )}
      </main>
    </div>
  );
}
