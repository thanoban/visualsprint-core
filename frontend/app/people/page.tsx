"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type { PersonDetail, PersonListItem, PersonKnowledgeOut } from "@/lib/types";

const serif = "'Source Serif 4', serif";
const mono = "'IBM Plex Mono', monospace";

function stateColor(state: string): [string, string] {
  if (state === "resolved") return ["var(--accent-strong)", "var(--accent-bg)"];
  if (state === "reopened" || state === "recurring") return ["var(--evidence)", "var(--evidence-bg)"];
  if (state === "superseded") return ["var(--text-faint)", "var(--surface2)"];
  return ["var(--text-muted)", "var(--surface2)"];
}

function ItemRow({ item }: { item: PersonKnowledgeOut }) {
  const [fg, bg] = stateColor(item.lifecycle_state);
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "14px 0" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontFamily: mono, fontSize: 10.5, color: "var(--text-faint)", textTransform: "uppercase" }}>
          {item.type}
        </span>
        <span style={{ fontSize: 11.5, color: fg, background: bg, borderRadius: 4, padding: "2px 8px" }}>
          {item.lifecycle_state}
        </span>
        {item.owner_confidence !== null && (
          <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
            owner confidence {(item.owner_confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <p style={{ fontSize: 14.5, color: "var(--text)", margin: "8px 0 4px", lineHeight: 1.45 }}>
        {item.statement}
      </p>
      <p style={{ fontSize: 12, color: "var(--text-faint)", margin: 0 }}>
        {item.meeting_title}
        {item.due_at ? ` · due ${new Date(item.due_at).toLocaleDateString()}` : ""}
      </p>
      {item.blockers.length > 0 && (
        <div style={{ marginTop: 8, background: "var(--evidence-bg)", color: "var(--evidence)", borderRadius: 6, padding: "8px 10px", fontSize: 12.5 }}>
          Blocked by: {item.blockers.map((b) => b.statement).join("; ")}
        </div>
      )}
    </div>
  );
}

export default function PeoplePage() {
  const { me, authedFetch } = useAuth();
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!me) return;
    authedFetch(`/api/v1/orgs/${me.org.id}/people`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<PersonListItem[]>;
      })
      .then((rows) => {
        setPeople(rows);
        setSelectedId((current) => current ?? rows[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load people"))
      .finally(() => setLoading(false));
  }, [me, authedFetch]);

  useEffect(() => {
    if (!me || !selectedId) return;
    authedFetch(`/api/v1/orgs/${me.org.id}/people/${selectedId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<PersonDetail>;
      })
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load person"));
  }, [me, selectedId, authedFetch]);

  if (loading) return <p style={{ padding: 32, color: "var(--text-muted)" }}>Loading people…</p>;
  if (error) return <p style={{ margin: 32, color: "var(--gap)" }}>{error}</p>;

  return (
    <div>
      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--border)" }}>
        <p style={{ fontFamily: serif, fontSize: 20, color: "var(--text)", margin: 0 }}>People</p>
        <p style={{ fontSize: 13, color: "var(--text-faint)", margin: "6px 0 0" }}>
          Commitments, blockers, and decisions by person, with attribution confidence visible.
        </p>
      </header>

      <main style={{ padding: "28px 32px 64px", display: "grid", gridTemplateColumns: "280px minmax(0, 760px)", gap: 28 }}>
        <aside style={{ borderRight: "1px solid var(--border)", paddingRight: 20 }}>
          {people.length === 0 ? (
            <p style={{ color: "var(--text-faint)", fontSize: 14 }}>No people yet.</p>
          ) : (
            people.map((person) => {
              const active = person.id === selectedId;
              return (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => setSelectedId(person.id)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: active ? "var(--accent-bg)" : "transparent",
                    color: active ? "var(--accent-strong)" : "var(--text)",
                    border: "none",
                    borderRadius: 7,
                    padding: "10px 12px",
                    cursor: "pointer",
                    marginBottom: 4,
                  }}
                >
                  <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>{person.display_name}</span>
                  <span style={{ display: "block", color: "var(--text-faint)", fontSize: 12, marginTop: 2 }}>
                    {person.open_commitments} open · {person.overdue_commitments} overdue
                  </span>
                </button>
              );
            })
          )}
        </aside>

        {detail && (
          <section>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
              <div>
                <h1 style={{ fontFamily: serif, fontSize: 28, margin: 0, color: "var(--text)" }}>
                  {detail.display_name}
                </h1>
                <p style={{ color: "var(--text-faint)", fontSize: 13, margin: "6px 0 0" }}>
                  {detail.email ?? "No email linked"}
                </p>
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", minWidth: 190 }}>
                <p style={{ fontFamily: mono, fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", margin: "0 0 6px" }}>
                  Coverage disclosure
                </p>
                <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                  {detail.coverage.low_confidence_or_gap_count} low-confidence utterances · {detail.coverage.excluded_item_count} owner candidates excluded
                </p>
              </div>
            </div>

            <section style={{ marginTop: 26 }}>
              <p style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", margin: 0 }}>
                Commitments
              </p>
              {detail.commitments.length === 0 ? (
                <p style={{ color: "var(--text-faint)", fontSize: 14 }}>No verified commitments.</p>
              ) : (
                detail.commitments.map((item) => <ItemRow key={item.id} item={item} />)
              )}
            </section>

            <section style={{ marginTop: 28 }}>
              <p style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", margin: 0 }}>
                Decisions authored
              </p>
              {detail.decisions_authored.length === 0 ? (
                <p style={{ color: "var(--text-faint)", fontSize: 14 }}>No verified decisions.</p>
              ) : (
                detail.decisions_authored.map((item) => <ItemRow key={item.id} item={item} />)
              )}
            </section>
          </section>
        )}
      </main>
    </div>
  );
}
