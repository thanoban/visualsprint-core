"use client";

// Ported from the Claude Design project "Visualsprint core development" ->
// Report.dc.html. AppSidebar isn't re-embedded here (unlike the mockup's
// dc-import) -- lib/AppShell.tsx already wraps every authenticated route
// with the real AppSidebar component, so this file only needs the content
// pane. Uses the app's shared --bg/--text/etc. custom properties (not a
// hardcoded LIGHT set like login/welcome) since this page should follow the
// sidebar's dark-mode toggle, same as every other authenticated page.

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/AuthProvider";
import type {
  ConfidenceLevel,
  EvidenceRef,
  KnowledgeItem,
  KnowledgeItemType,
  MeetingReport,
} from "@/lib/types";

const sans = "'IBM Plex Sans', sans-serif";
const serif = "'Source Serif 4', serif";
const mono = "'IBM Plex Mono', monospace";

const TYPE_LABELS: Record<KnowledgeItemType, string> = {
  decision: "Decision",
  commitment: "Commitment",
  requirement: "Requirement",
  blocker: "Blocker",
  question: "Question",
  fact: "Fact",
};

const CONF_LABELS: Record<ConfidenceLevel, string> = {
  verified: "Verified",
  partially_supported: "Partially supported",
  ambiguous: "Ambiguous",
  unsupported: "Unsupported",
};

// [fg, bg, dot]
const CONF_COLOR: Record<ConfidenceLevel, [string, string, string]> = {
  verified: ["var(--accent-strong)", "var(--accent-bg)", "var(--accent)"],
  partially_supported: ["var(--evidence)", "var(--evidence-bg)", "var(--evidence)"],
  ambiguous: ["var(--text-faint)", "var(--surface2)", "var(--text-faint)"],
  unsupported: ["var(--gap)", "var(--gap-bg)", "var(--gap)"],
};

const LANG_COLOR: Record<string, [string, string]> = {
  si: ["var(--accent-strong)", "var(--accent-bg)"],
  ta: ["var(--evidence)", "var(--evidence-bg)"],
};
function langColor(lang: string): [string, string] {
  return LANG_COLOR[lang] ?? ["var(--text-faint)", "var(--surface2)"];
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface FlatItem extends KnowledgeItem {
  type: KnowledgeItemType;
}

function flattenItems(report: MeetingReport): FlatItem[] {
  const groups: [KnowledgeItemType, KnowledgeItem[]][] = [
    ["decision", report.decisions],
    ["commitment", report.commitments],
    ["requirement", report.requirements],
    ["blocker", report.blockers],
    ["question", report.questions],
    ["fact", report.facts],
  ];
  return groups.flatMap(([type, items]) => items.map((item) => ({ ...item, type })));
}

const PARTICIPANT_PALETTE = ["var(--accent)", "var(--evidence)", "var(--text-muted)", "var(--text-faint)"];

function EvidenceRow({ ev }: { ev: EvidenceRef }) {
  const [langFg, langBg] = ev.quote_lang_tags?.[0] ? langColor(ev.quote_lang_tags[0]) : ["", ""];
  return (
    <div style={{ display: "flex", gap: 12 }}>
      {ev.keyframe_thumbnail_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={ev.keyframe_thumbnail_url}
          alt={ev.keyframe_caption ?? `Screen evidence at ${formatTimestamp(ev.timestamp_s)}`}
          style={{ width: 76, height: 52, flexShrink: 0, background: "#232830", borderRadius: 6, border: "1px solid var(--border)", objectFit: "cover" }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontFamily: mono, fontSize: 11.5, color: "var(--text-faint)", margin: "0 0 4px" }}>
          {ev.speaker} · {formatTimestamp(ev.timestamp_s)}
          {ev.quote_lang_tags && ev.quote_lang_tags.length > 0 && (
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                fontWeight: 600,
                color: langFg,
                background: langBg,
                padding: "1px 6px",
                borderRadius: 3,
                marginLeft: 6,
              }}
            >
              {ev.quote_lang_tags.join("+").toUpperCase()}
            </span>
          )}
        </p>
        {ev.quote && (
          <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--text-muted)", margin: 0 }}>&quot;{ev.quote}&quot;</p>
        )}
        {ev.keyframe_caption && (
          <p style={{ fontSize: 12, color: "var(--text-faint)", margin: "4px 0 0" }}>{ev.keyframe_caption}</p>
        )}
      </div>
    </div>
  );
}

function ItemCard({ item }: { item: FlatItem }) {
  const [confFg, confBg, confDot] = CONF_COLOR[item.confidence];
  return (
    <article
      style={{
        background: "var(--surface)",
        border: `1px solid ${item.coverage_gap ? "var(--gap)" : "var(--border)"}`,
        borderRadius: 10,
        padding: "22px 24px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span
            style={{
              fontFamily: mono,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              color: "var(--text-faint)",
              border: "1px solid var(--border-strong)",
              padding: "3px 9px",
              borderRadius: 4,
            }}
          >
            {TYPE_LABELS[item.type]}
          </span>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 500,
              color:
                item.lifecycle_state === "recurring"
                  ? "var(--evidence)"
                  : item.lifecycle_state === "resolved"
                    ? "var(--accent-strong)"
                    : "var(--text-faint)",
              background:
                item.lifecycle_state === "recurring"
                  ? "var(--evidence-bg)"
                  : item.lifecycle_state === "resolved"
                    ? "var(--accent-bg)"
                    : "var(--surface2)",
              padding: "3px 9px",
              borderRadius: 4,
            }}
          >
            {item.lifecycle_state}
          </span>
          {item.coverage_gap && (
            <span
              style={{
                fontFamily: mono,
                fontSize: 11,
                fontWeight: 600,
                color: "var(--gap)",
                background: "var(--gap-bg)",
                padding: "3px 9px",
                borderRadius: 4,
              }}
            >
              ⚠ overlaps gap
            </span>
          )}
        </div>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: confFg,
            background: confBg,
            padding: "4px 10px",
            borderRadius: 20,
            flexShrink: 0,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: confDot, display: "inline-block" }} />
          {CONF_LABELS[item.confidence]}
        </span>
      </div>

      <p style={{ fontFamily: serif, fontSize: 18, lineHeight: 1.4, color: "var(--text)", margin: "14px 0 4px" }}>
        {item.statement}
      </p>
      {(item.owner || item.due) && (
        <p style={{ fontSize: 12.5, color: "var(--text-faint)", margin: "0 0 14px" }}>
          {item.owner && `Owner: ${item.owner}`}
          {item.owner && item.due && " · "}
          {item.due && `Due: ${item.due}`}
        </p>
      )}

      {item.evidence.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          {item.evidence.map((ev) => (
            <EvidenceRow key={ev.id} ev={ev} />
          ))}
        </div>
      )}
    </article>
  );
}

export default function MeetingReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authedFetch, session, loading: authLoading } = useAuth();
  const [report, setReport] = useState<MeetingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<KnowledgeItemType | "all">("all");

  const fetchReport = useCallback(async () => {
    const res = await authedFetch(`/api/v1/meetings/${id}/report`);
    if (res.status === 404) throw new Error("No capture session found with this ID.");
    if (!res.ok) {
      let detail = `${res.status}`;
      try { const body = await res.json(); detail = body?.detail?.[0]?.msg ?? body?.detail ?? detail; } catch { /* ignore */ }
      throw new Error(detail);
    }
    return (await res.json()) as MeetingReport;
  }, [authedFetch, id]);

  useEffect(() => {
    // Don't fetch until auth is resolved — avoids 422 from missing Authorization header
    // when the component first renders before Supabase getSession() completes.
    if (authLoading || !session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchReport()
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load report");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchReport, authLoading, session]);

  if (authLoading) {
    return <p style={{ fontSize: 14, color: "var(--text-muted)", padding: 32 }}>Loading…</p>;
  }

  if (loading) {
    return <p style={{ fontSize: 14, color: "var(--text-muted)", padding: 32 }}>Loading report…</p>;
  }

  if (error || !report) {
    return (
      <p
        style={{
          margin: 32,
          borderRadius: 6,
          background: "var(--gap-bg)",
          border: "1px solid var(--gap)",
          padding: "8px 12px",
          fontSize: 14,
          color: "var(--gap)",
        }}
      >
        {error ?? "Report not found."}
      </p>
    );
  }

  const allItems = flattenItems(report);
  const counts: Record<string, number> = { all: allItems.length };
  (Object.keys(TYPE_LABELS) as KnowledgeItemType[]).forEach((t) => {
    counts[t] = allItems.filter((i) => i.type === t).length;
  });
  const tabDefs: [KnowledgeItemType | "all", string][] = [
    ["all", "All"],
    ...(Object.entries(TYPE_LABELS) as [KnowledgeItemType, string][]),
  ];
  const visibleItems = filter === "all" ? allItems : allItems.filter((i) => i.type === filter);
  const maxTalkPct = Math.max(...report.engagement.participants.map((p) => p.talk_time_pct), 1);

  return (
    <div>
      <header
        style={{
          padding: "20px 32px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <p style={{ fontSize: 13, color: "var(--text-faint)", margin: 0 }}>
            Meetings / {report.title}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 6 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {new Date(report.occurred_at).toLocaleDateString()}
            </span>
            <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--text-faint)", display: "inline-block" }} />
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Meeting {report.meeting_id}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <Link
            href={`/meetings/${report.capture_session_id}/correct`}
            style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-muted)" }}
          >
            Fix transcript →
          </Link>
          <Link
            href="/chat"
            style={{
              fontFamily: sans,
              fontSize: 13.5,
              fontWeight: 600,
              color: "#fff",
              background: "var(--accent-strong)",
              padding: "9px 16px",
              borderRadius: 7,
            }}
          >
            Ask about this meeting →
          </Link>
        </div>
      </header>

      <main style={{ padding: "28px 32px 64px", maxWidth: 920 }}>
        {report.executive_summary && (
          <section
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "22px 24px",
              marginBottom: 24,
            }}
          >
            <p
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-faint)",
                margin: "0 0 10px",
                fontFamily: mono,
              }}
            >
              Executive summary
            </p>
            <p style={{ fontFamily: serif, fontSize: 16, lineHeight: 1.65, color: "var(--text)", margin: 0 }}>
              {report.executive_summary}
            </p>
          </section>
        )}

        {allItems.length === 0 && (
          <p
            style={{
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--surface2)",
              padding: "12px 16px",
              fontSize: 14,
              color: "var(--text-muted)",
              marginBottom: 20,
            }}
          >
            No knowledge items yet. Either the pipeline hasn&apos;t finished processing this meeting, or nothing
            verifiable was extracted from it.
          </p>
        )}

        {report.coverage_gaps.map((gap) => (
          <div
            key={gap.id}
            style={{ background: "var(--gap-bg)", border: "1px solid var(--gap)", borderRadius: 10, padding: "16px 20px", marginBottom: 20 }}
          >
            <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, color: "var(--gap)" }}>
              ⚠ Coverage gap · {formatTimestamp(gap.start_s)}–{formatTimestamp(gap.end_s)}
            </span>
            <p style={{ fontSize: 13.5, color: "var(--text-muted)", margin: "6px 0 0", lineHeight: 1.55 }}>
              {gap.modality} {gap.status} — {gap.reason}
            </p>
          </div>
        ))}

        {report.engagement.participants.length > 0 && (
          <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "22px 24px" }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.03em", margin: "0 0 16px" }}>
              Speech captured per speaker
            </p>
            <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", marginBottom: 18 }}>
              {report.engagement.participants.map((p, i) => (
                <div
                  key={p.person_id ?? i}
                  title={p.display_name}
                  style={{ width: `${p.talk_time_pct}%`, background: PARTICIPANT_PALETTE[i % PARTICIPANT_PALETTE.length] }}
                />
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px 28px" }}>
              {report.engagement.participants.map((p, i) => (
                <div key={p.person_id ?? i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: PARTICIPANT_PALETTE[i % PARTICIPANT_PALETTE.length],
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text)", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {p.display_name}
                    </p>
                    <p style={{ fontFamily: mono, fontSize: 12, color: "var(--text-faint)", margin: "2px 0 0" }}>
                      {formatTimestamp(p.talk_time_s)} captured · {p.utterance_count} utterances
                    </p>
                  </div>
                  <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, color: "var(--text-muted)" }}>
                    {p.talk_time_pct.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section style={{ marginTop: 32 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {tabDefs.map(([key, label]) => {
              const isActive = filter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  style={
                    isActive
                      ? { fontFamily: sans, fontSize: 13, fontWeight: 600, color: "#fff", background: "var(--accent-strong)", border: "1px solid var(--accent-strong)", padding: "7px 13px", borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap" }
                      : { fontFamily: sans, fontSize: 13, fontWeight: 500, color: "var(--text-muted)", background: "var(--surface)", border: "1px solid var(--border)", padding: "7px 13px", borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap" }
                  }
                >
                  {label}{" "}
                  <span style={{ fontFamily: mono, fontSize: 11, color: isActive ? "rgba(255,255,255,.75)" : "var(--text-faint)" }}>
                    {counts[key] ?? 0}
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 18 }}>
            {visibleItems.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
