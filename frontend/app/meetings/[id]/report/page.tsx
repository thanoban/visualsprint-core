"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { API_BASE_URL } from "@/lib/config";
import type { ConfidenceLevel, EngagementSummary, KnowledgeItem, MeetingReport } from "@/lib/types";

/** `params.id` is a capture_session_id (see lib/types.ts MeetingReport doc),
 * not a meeting_id — a meeting can have more than one capture session, so
 * the report is scoped to one session's evidence. */
async function fetchMeetingReport(captureSessionId: string): Promise<MeetingReport> {
  const res = await fetch(`${API_BASE_URL}/api/v1/meetings/${captureSessionId}/report`);
  if (res.status === 404) {
    throw new Error("No capture session found with this ID.");
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as MeetingReport;
}

/** A session that hasn't reached the `remember`/`report` stages yet returns
 * 200 with every group empty — a legitimate, common state, not an error. */
function isEmptyReport(report: MeetingReport): boolean {
  return (
    report.decisions.length === 0 &&
    report.commitments.length === 0 &&
    report.requirements.length === 0 &&
    report.blockers.length === 0 &&
    report.questions.length === 0 &&
    report.facts.length === 0
  );
}

const LANG_LABELS: Record<string, string> = { si: "Sinhala", ta: "Tamil", en: "English", und: "unknown" };

/** Bar-chart participant engagement -- talk-time-per-person, matching what
 * every competitor (Zoom AI Companion, Fireflies, Otter) ships in their
 * report. Plain divs, no chart library -- consistent with the rest of this
 * scaffold's "no heavy UI dependency" approach. */
function EngagementSection({ engagement }: { engagement: EngagementSummary }) {
  if (engagement.participants.length === 0) return null;
  const maxPct = Math.max(...engagement.participants.map((p) => p.talk_time_pct), 1);

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">Participant engagement</h2>
      <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
        {engagement.participants.map((p) => (
          <div key={p.person_id ?? "unknown"} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className={p.person_id ? "font-medium text-slate-800" : "italic text-slate-500"}>
                {p.display_name}
              </span>
              <span className="text-xs text-slate-500">
                {formatTimestamp(p.talk_time_s)} · {p.talk_time_pct.toFixed(1)}% · {p.utterance_count} turns
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-100">
              <div
                className={`h-2 rounded-full ${p.person_id ? "bg-indigo-500" : "bg-slate-300"}`}
                style={{ width: `${(p.talk_time_pct / maxPct) * 100}%` }}
              />
            </div>
          </div>
        ))}
        <p className="pt-1 text-xs text-slate-400">
          Total talk time {formatTimestamp(engagement.total_talk_time_s)}. &ldquo;Unknown speaker&rdquo; means
          mixed audio without per-participant attribution for this capture mode — an honest gap, not a bug.
        </p>
      </div>
    </section>
  );
}

const CONFIDENCE_STYLES: Record<ConfidenceLevel, string> = {
  verified: "bg-green-100 text-green-800 border-green-300",
  partially_supported: "bg-yellow-100 text-yellow-800 border-yellow-300",
  ambiguous: "bg-orange-100 text-orange-800 border-orange-300",
  unsupported: "bg-red-100 text-red-800 border-red-300",
};

const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  verified: "Verified",
  partially_supported: "Partially supported",
  ambiguous: "Ambiguous",
  unsupported: "Unsupported",
};

function ConfidenceBadge({ level }: { level: ConfidenceLevel }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${CONFIDENCE_STYLES[level]}`}
    >
      {CONFIDENCE_LABELS[level]}
    </span>
  );
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ItemCard({ item }: { item: KnowledgeItem }) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-slate-900 font-medium">{item.statement}</p>
        <ConfidenceBadge level={item.confidence} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        {item.owner && <span>Owner: {item.owner}</span>}
        {item.due && <span>Due: {item.due}</span>}
        <span className="rounded bg-slate-100 px-1.5 py-0.5">{item.lifecycle_state}</span>
        {item.coverage_gap && (
          <span className="rounded bg-orange-100 text-orange-700 px-1.5 py-0.5">
            overlaps capture gap
          </span>
        )}
      </div>

      {item.rationale && (
        <p className="text-xs text-slate-500 italic border-l-2 border-slate-200 pl-2">{item.rationale}</p>
      )}

      <div className="space-y-2">
        {item.evidence.map((ev) => (
          <div key={ev.id} className="flex gap-3 rounded-md bg-slate-50 p-2">
            {ev.keyframe_thumbnail_url && (
              // Inline screenshot thumbnail — per product requirement, not just a link.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={ev.keyframe_thumbnail_url}
                alt={ev.keyframe_caption ?? `Screen evidence at ${formatTimestamp(ev.timestamp_s)}`}
                className="h-16 w-28 flex-shrink-0 rounded border border-slate-200 object-cover"
              />
            )}
            <div className="min-w-0 text-xs text-slate-600">
              <div className="font-medium text-slate-700">
                {ev.speaker} · {formatTimestamp(ev.timestamp_s)}
              </div>
              {ev.quote && (
                <p className="mt-0.5 italic">
                  &ldquo;{ev.quote}&rdquo;
                  {ev.quote_lang_tags && ev.quote_lang_tags.length > 0 && (
                    <span className="ml-1 not-italic text-slate-400">
                      ({ev.quote_lang_tags.map((l) => LANG_LABELS[l] ?? l).join("/")}, verbatim)
                    </span>
                  )}
                </p>
              )}
              {ev.keyframe_caption && <p className="mt-0.5 text-slate-500">{ev.keyframe_caption}</p>}
            </div>
          </div>
        ))}
      </div>
    </li>
  );
}

function Section({ title, items }: { title: string; items: KnowledgeItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">
        {title} <span className="text-sm font-normal text-slate-400">({items.length})</span>
      </h2>
      <ul className="space-y-3">
        {items.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

export default function MeetingReportPage({ params }: { params: Promise<{ id: string }> }) {
  // Next.js 15+ made route params async -- `use()` unwraps the promise in a
  // client component. Accessing `params.id` directly here silently resolves
  // to undefined and produces a request to `/meetings/undefined/report`.
  const { id } = use(params);
  const [report, setReport] = useState<MeetingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Resets loading/error for a re-fetch when `id` changes (navigating
    // between meetings), not a redundant call on initial mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);

    fetchMeetingReport(id)
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
  }, [id]);

  if (loading) {
    return <p className="text-sm text-slate-500">Loading report…</p>;
  }

  if (error || !report) {
    return (
      <p className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
        {error ?? "Report not found."}
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{report.title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {new Date(report.occurred_at).toLocaleString()} · Meeting {report.meeting_id}
          </p>
        </div>
        <Link
          href={`/meetings/${report.capture_session_id}/correct`}
          className="flex-shrink-0 text-sm font-medium text-brand-600 hover:text-brand-700"
        >
          Fix transcript →
        </Link>
      </div>

      {isEmptyReport(report) && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          No knowledge items yet. Either the pipeline hasn&apos;t finished processing this meeting, or
          nothing verifiable was extracted from it.
        </p>
      )}

      {report.coverage_gaps.length > 0 && (
        <div className="rounded-lg border border-orange-300 bg-orange-50 p-4">
          <h2 className="text-sm font-semibold text-orange-800">Capture coverage gaps</h2>
          <ul className="mt-2 space-y-1 text-sm text-orange-800">
            {report.coverage_gaps.map((gap) => (
              <li key={gap.id}>
                <span className="font-medium">
                  {gap.modality} {gap.status}
                </span>{" "}
                from {formatTimestamp(gap.start_s)} to {formatTimestamp(gap.end_s)} — {gap.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <EngagementSection engagement={report.engagement} />

      <Section title="Decisions" items={report.decisions} />
      <Section title="Commitments" items={report.commitments} />
      <Section title="Requirements" items={report.requirements} />
      <Section title="Blockers" items={report.blockers} />
      <Section title="Questions" items={report.questions} />
      <Section title="Facts" items={report.facts} />
    </div>
  );
}
