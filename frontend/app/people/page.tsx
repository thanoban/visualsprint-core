"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type {
  InteractionMapOut,
  PersonAnalysisOut,
  PersonDetail,
  PersonListItem,
  PersonKnowledgeOut,
} from "@/lib/types";

const serif = "'Source Serif 4', serif";
const mono = "'IBM Plex Mono', monospace";

function stateColor(state: string): [string, string] {
  if (state === "resolved") return ["var(--success)", "var(--success-bg)"];
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

function EvidenceLink({ item, children }: { item: PersonKnowledgeOut; children: React.ReactNode }) {
  return <a href={item.evidence_url} style={{ color: "inherit", textDecoration: "none" }}>{children}</a>;
}

function AnalysisGraphs({ analysis }: { analysis: PersonAnalysisOut }) {
  const funnel = analysis.commitment_funnel;
  const maxTrend = Math.max(1, ...analysis.follow_through_trend.map((point) => point.total));
  const firstEvidence = analysis.commitment_timeline[0]?.evidence_url ?? "#";
  return (
    <section style={{ marginTop: 28 }}>
      <p style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase" }}>
        Longitudinal intelligence
      </p>
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: 0, color: "var(--text)", lineHeight: 1.5 }}>
          {analysis.available ? analysis.summary : "No audited longitudinal analysis yet. Deterministic history remains available below."}
        </p>
        {(analysis.coverage.coverage_gap_count ?? 0) > 0 && (
          <p style={{ color: "var(--text-faint)", fontSize: 12.5 }}>
            Coverage gap: {analysis.coverage.coverage_gap_count} interval(s). Grey/hatched chart marks are missing evidence, not zero activity.
          </p>
        )}
      </div>

      {analysis.commitment_timeline.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <p style={{ fontSize: 12, color: "var(--text-faint)" }}>Commitment timeline</p>
          {analysis.commitment_timeline.map((item, index) => (
            <EvidenceLink key={item.id} item={item}>
              <div style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: 10, alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>{new Date(item.occurred_at).toLocaleDateString()}</span>
                <span title={item.statement} style={{ display: "block", height: 16, width: `${Math.max(20, ((index + 1) / analysis.commitment_timeline.length) * 100)}%`, borderRadius: 4, background: item.coverage_gap ? "repeating-linear-gradient(45deg,var(--surface2),var(--surface2) 4px,var(--border) 4px,var(--border) 8px)" : item.lifecycle_state === "resolved" ? "var(--success)" : "var(--border-strong)" }} />
              </div>
            </EvidenceLink>
          ))}
        </div>
      )}

      {funnel && funnel.stated > 0 && (
        <div style={{ marginTop: 18 }}>
          <p style={{ fontSize: 12, color: "var(--text-faint)" }}>Commitment funnel</p>
          <a href={firstEvidence} aria-label="Open commitment evidence" style={{ display: "flex", height: 24, borderRadius: 5, overflow: "hidden" }}>
            {(["delivered", "open", "blocked"] as const).map((key) => (
              <span key={key} title={`${key}: ${funnel[key]}`} style={{ width: `${(funnel[key] / funnel.stated) * 100}%`, minWidth: funnel[key] ? 3 : 0, background: key === "delivered" ? "var(--accent-strong)" : key === "blocked" ? "var(--evidence)" : "var(--border-strong)" }} />
            ))}
          </a>
          <p style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{funnel.delivered} delivered · {funnel.open} open · {funnel.blocked} blocked</p>
        </div>
      )}

      {Object.values(analysis.status_distribution).some(Boolean) && (
        <div style={{ marginTop: 18 }}>
          <p style={{ fontSize: 12, color: "var(--text-faint)" }}>Status distribution</p>
          <a href={firstEvidence} style={{ display: "flex", minHeight: 22, borderRadius: 5, overflow: "hidden" }}>
            {Object.entries(analysis.status_distribution).filter(([, count]) => count > 0).map(([state, count], index) => (
              <span key={state} title={`${state}: ${count}`} style={{ flex: count, background: index % 2 ? "var(--evidence)" : "var(--accent-strong)", minWidth: 4 }} />
            ))}
          </a>
        </div>
      )}

      {analysis.follow_through_trend.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <p style={{ fontSize: 12, color: "var(--text-faint)" }}>Follow-through trend</p>
          <div style={{ display: "flex", alignItems: "end", gap: 8, height: 110 }}>
            {analysis.follow_through_trend.map((point) => (
              <a key={point.period} href={point.evidence_url ?? "#"} title={`${point.period}: ${point.delivered}/${point.total}`} style={{ flex: 1, height: `${Math.max(10, (point.total / maxTrend) * 100)}%`, background: point.coverage_gap ? "repeating-linear-gradient(45deg,var(--surface2),var(--surface2) 4px,var(--border) 4px,var(--border) 8px)" : "var(--accent-strong)", borderRadius: "4px 4px 0 0", position: "relative" }}>
                <span style={{ position: "absolute", bottom: -20, fontSize: 10, color: "var(--text-faint)" }}>{point.period}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {analysis.recurrence_heat_strip.map((row, index) => (
        <div key={index} style={{ display: "grid", gridTemplateColumns: `repeat(${row.length}, minmax(24px, 1fr))`, gap: 4, marginTop: 18 }}>
          {row.map((item) => (
            <EvidenceLink key={item.id} item={item}>
              <div title={`${item.meeting_title}: ${item.statement}`} style={{ height: 26, borderRadius: 4, background: item.coverage_gap ? "var(--surface2)" : "var(--evidence)", border: item.coverage_gap ? "1px dashed var(--text-faint)" : "none" }} />
            </EvidenceLink>
          ))}
        </div>
      ))}

      {analysis.decision_evolution.length > 0 && (
        <div style={{ marginTop: 22, borderLeft: "2px solid var(--border)", paddingLeft: 14 }}>
          <p style={{ fontSize: 12, color: "var(--text-faint)" }}>Decision evolution</p>
          {analysis.decision_evolution.map((hop) => (
            <a key={hop.edge_id} href={hop.evidence_url} style={{ display: "block", marginBottom: 12, color: "inherit", textDecoration: "none" }}>
              <p style={{ margin: 0, color: "var(--text)", fontSize: 13 }}>{hop.from_statement}</p>
              <p style={{ margin: "3px 0 0", color: "var(--text-faint)", fontSize: 11.5 }}>{hop.kind} · {hop.rationale || "No rationale captured"}</p>
            </a>
          ))}
        </div>
      )}

      {analysis.findings.map((finding) => (
        <div key={finding.id} style={{ marginTop: 14, background: "var(--surface2)", borderRadius: 7, padding: 12 }}>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--text)" }}>{finding.statement}</p>
          <p style={{ margin: "5px 0 0", fontSize: 11.5, color: "var(--text-faint)" }}>{finding.audit_status} · {finding.sample_size} evidence item(s)</p>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {finding.evidence.map((item) => <a key={item.id} href={item.evidence_url} style={{ fontSize: 11.5, color: "var(--accent-strong)" }}>{item.meeting_title}</a>)}
          </div>
        </div>
      ))}
    </section>
  );
}

function InteractionMap({ map, onSelect }: { map: InteractionMapOut; onSelect: (id: string) => void }) {
  if (map.nodes.length === 0) return null;
  const center = 130;
  const radius = 92;
  const positions = new Map(map.nodes.slice().sort((a, b) => a.person_id.localeCompare(b.person_id)).map((node, index, rows) => {
    const angle = (index / rows.length) * Math.PI * 2 - Math.PI / 2;
    return [node.person_id, { x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius }] as const;
  }));
  return (
    <section style={{ marginTop: 28 }}>
      <p style={{ fontFamily: mono, fontSize: 12, color: "var(--text-faint)", textTransform: "uppercase" }}>Interaction map</p>
      <svg viewBox="0 0 260 260" style={{ width: "100%", maxWidth: 420, border: "1px solid var(--border)", borderRadius: 10 }}>
        {map.edges.map((edge, index) => {
          const from = positions.get(edge.from_person_id); const to = positions.get(edge.to_person_id);
          if (!from || !to) return null;
          return <a key={`${edge.from_person_id}-${edge.to_person_id}-${index}`} href={edge.evidence_url}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="var(--border-strong)" strokeWidth={Math.min(5, 1 + edge.weight)}><title>{edge.kind}: {edge.weight}</title></line></a>;
        })}
        {map.nodes.map((node) => { const point = positions.get(node.person_id)!; return <g key={node.person_id} onClick={() => onSelect(node.person_id)} style={{ cursor: "pointer" }}><circle cx={point.x} cy={point.y} r="22" fill="var(--accent-bg)" stroke="var(--accent-strong)" /><text x={point.x} y={point.y + 4} textAnchor="middle" fontSize="9" fill="var(--text)">{node.display_name.slice(0, 12)}</text></g>; })}
      </svg>
    </section>
  );
}

export default function PeoplePage() {
  const { me, authedFetch } = useAuth();
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [analysis, setAnalysis] = useState<PersonAnalysisOut | null>(null);
  const [interactionMap, setInteractionMap] = useState<InteractionMapOut>({ nodes: [], edges: [] });
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
    authedFetch(`/api/v1/orgs/${me.org.id}/people/interactions/map`)
      .then((res) => res.ok ? res.json() as Promise<InteractionMapOut> : Promise.reject(new Error(`${res.status} ${res.statusText}`)))
      .then(setInteractionMap)
      .catch(() => setInteractionMap({ nodes: [], edges: [] }));
  }, [me, authedFetch]);

  useEffect(() => {
    if (!me || !selectedId) return;
    Promise.all([
      authedFetch(`/api/v1/orgs/${me.org.id}/people/${selectedId}`),
      authedFetch(`/api/v1/orgs/${me.org.id}/people/${selectedId}/analysis/latest`),
    ])
      .then(async ([detailResponse, analysisResponse]) => {
        if (!detailResponse.ok) throw new Error(`${detailResponse.status} ${detailResponse.statusText}`);
        if (!analysisResponse.ok) throw new Error(`${analysisResponse.status} ${analysisResponse.statusText}`);
        return [await detailResponse.json() as PersonDetail, await analysisResponse.json() as PersonAnalysisOut] as const;
      })
      .then(([personDetail, personAnalysis]) => { setDetail(personDetail); setAnalysis(personAnalysis); })
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

            {analysis && <AnalysisGraphs analysis={analysis} />}

            <InteractionMap map={interactionMap} onSelect={setSelectedId} />

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
