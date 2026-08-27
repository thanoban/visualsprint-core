"use client";

// Restyled to the Claude Design project "VisualSprint landing redesign" ->
// VisualSprint App.dc.html (Meetings screen). The mockup's stat-tile row
// shows four numbers (decisions this week / open commitments / capture
// coverage / awaiting approval) and per-row "4 dec · 6 com" pills -- only
// two of those six numbers are backed by data this app's real endpoints
// return today (has_coverage_gap per meeting, and the real pending-actions
// count from /actions), so only those two are shown. The rest would mean
// fetching every meeting's full report just to populate a dashboard number,
// which isn't worth doing here -- same "don't fabricate what isn't real"
// principle the pre-redesign page already followed.

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type { MeetingListItem, ProposedActionOut } from "@/lib/types";

const sans = "'Plus Jakarta Sans', sans-serif";
const mono = "'IBM Plex Mono', monospace";

const PLATFORM_TONE: Record<string, [string, string]> = {
  zoom: ["var(--blue-strong)", "var(--blue-soft)"],
  meet: ["var(--green)", "var(--green-soft)"],
  teams: ["#5b5fc7", "#eeeffc"],
};
function platformTone(platform: string): [string, string] {
  return PLATFORM_TONE[platform.toLowerCase()] ?? ["var(--muted)", "var(--soft)"];
}

function formatDate(value: string | null): string {
  if (!value) return "Unscheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function stateTone(state: string | null): { bg: string; fg: string; label: string } {
  switch (state) {
    case "done":
      return { bg: "var(--green-soft)", fg: "var(--green)", label: "Ready" };
    case "failed":
      return { bg: "var(--red-soft)", fg: "var(--red)", label: "Failed" };
    case "reporting":
    case "proposing":
    case "remembering":
    case "verifying":
    case "understanding":
    case "processing_screen":
    case "transcribing":
    case "identifying":
    case "diarizing":
    case "acquiring":
      return { bg: "var(--amber-soft)", fg: "var(--amber)", label: "Processing" };
    case "scheduled":
      return { bg: "var(--soft)", fg: "var(--muted)", label: "Scheduled" };
    default:
      return { bg: "var(--soft)", fg: "var(--faint)", label: state ?? "No capture yet" };
  }
}

function StatTile({ label, value, sub, dark }: { label: string; value: string; sub?: string; dark?: boolean }) {
  return (
    <div
      style={{
        background: dark ? "var(--text)" : "var(--bg)",
        border: `1px solid ${dark ? "var(--text)" : "var(--border)"}`,
        borderRadius: 16,
        padding: "18px 20px",
      }}
    >
      <p
        style={{
          fontFamily: mono,
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          color: dark ? "rgba(255,255,255,.55)" : "var(--faint)",
          margin: "0 0 10px",
        }}
      >
        {label}
      </p>
      <p
        style={{
          fontSize: 30,
          fontWeight: 800,
          letterSpacing: "-0.03em",
          margin: "0 0 4px",
          color: dark ? "#fff" : "var(--text)",
        }}
      >
        {value}
      </p>
      {sub && <p style={{ fontSize: 12, color: dark ? "rgba(255,255,255,.75)" : "var(--muted)", margin: 0, fontWeight: 600 }}>{sub}</p>}
    </div>
  );
}

export default function MeetingsPage() {
  const { me, authedFetch } = useAuth();
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);
  const [actions, setActions] = useState<ProposedActionOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    authedFetch(`/api/v1/orgs/${me.org.id}/meetings`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<MeetingListItem[]>;
      })
      .then(setMeetings)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load meetings."));

    // Best-effort -- the stat tile just omits the "Awaiting approval" number
    // if this fails, rather than blocking or erroring the whole page.
    authedFetch(`/api/v1/orgs/${me.org.id}/actions`)
      .then((res) => (res.ok ? (res.json() as Promise<ProposedActionOut[]>) : null))
      .then((data) => setActions(data))
      .catch(() => setActions(null));
  }, [me, authedFetch]);

  if (error) {
    return (
      <p style={{ margin: 32, borderRadius: 8, background: "var(--red-soft)", border: "1px solid var(--red)", padding: "8px 12px", fontSize: 14, color: "var(--red)" }}>
        {error}
      </p>
    );
  }

  if (!me || meetings === null) {
    return <p style={{ fontSize: 14, color: "var(--muted)", padding: 32 }}>Loading meetings…</p>;
  }

  const pendingCount = actions?.filter((a) => a.status === "pending_approval").length ?? null;
  const gapCount = meetings.filter((m) => m.has_coverage_gap).length;
  const coveragePct = meetings.length > 0 ? Math.round(((meetings.length - gapCount) / meetings.length) * 100) : null;

  return (
    <div>
      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--border)" }}>
        <p style={{ fontFamily: sans, fontWeight: 800, fontSize: 19, letterSpacing: "-0.02em", color: "var(--text)", margin: 0 }}>Meetings</p>
        <p style={{ fontSize: 13, color: "var(--faint)", margin: "6px 0 0" }}>
          Browse captured and scheduled meetings, then jump straight to their evidence-backed report.
        </p>
      </header>

      <main style={{ padding: "28px 32px 64px", maxWidth: 1140 }}>
        {meetings.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14, marginBottom: 22 }}>
            {coveragePct !== null && (
              <StatTile
                label="Capture coverage"
                value={`${coveragePct}%`}
                sub={gapCount > 0 ? `${gapCount} gap${gapCount === 1 ? "" : "s"} disclosed` : "No gaps disclosed"}
              />
            )}
            {pendingCount !== null && (
              <StatTile label="Awaiting approval" value={String(pendingCount)} dark />
            )}
          </div>
        )}

        {meetings.length === 0 ? (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 16, padding: "22px 24px" }}>
            <p style={{ fontSize: 14, color: "var(--muted)", margin: 0 }}>
              No meetings yet. Upload a recording or connect a calendar to populate this list.
            </p>
          </div>
        ) : (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden" }}>
            {meetings.map((meeting) => {
              const tone = stateTone(meeting.latest_capture_state);
              const [platFg, platBg] = platformTone(meeting.platform);
              return (
                <article key={meeting.id} style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                        <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: platFg, background: platBg, padding: "3px 8px", borderRadius: 6, textTransform: "uppercase" }}>
                          {meeting.platform}
                        </span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: tone.fg, background: tone.bg, padding: "3px 9px", borderRadius: 20 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: tone.fg, display: "inline-block" }} />
                          {tone.label}
                        </span>
                        {meeting.latest_bot_status && meeting.latest_capture_session_id === null && (
                          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--amber)", background: "var(--amber-soft)", padding: "3px 9px", borderRadius: 20 }}>
                            Bot {meeting.latest_bot_status.replaceAll("_", " ")}
                          </span>
                        )}
                        {meeting.has_coverage_gap && (
                          <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: "var(--red)", background: "var(--red-soft)", padding: "3px 9px", borderRadius: 6 }}>
                            ⚠ Coverage gap
                          </span>
                        )}
                      </div>
                      <p style={{ fontFamily: sans, fontWeight: 700, fontSize: 15, color: "var(--text)", margin: "0 0 4px" }}>
                        {meeting.title}
                      </p>
                      <p style={{ fontFamily: mono, fontSize: 11.5, color: "var(--faint)", margin: 0 }}>
                        {formatDate(meeting.scheduled_start)}
                      </p>
                      {meeting.latest_capture_error && (
                        <p style={{ fontSize: 12.5, color: "var(--red)", margin: "10px 0 0" }}>
                          {meeting.latest_capture_error}
                        </p>
                      )}
                      {meeting.latest_bot_status === "failed" && meeting.latest_bot_error && (
                        <p style={{ fontSize: 12.5, color: "var(--red)", margin: "10px 0 0", fontFamily: mono }}>
                          {meeting.latest_bot_error}
                        </p>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {meeting.latest_capture_session_id ? (
                        <>
                          <Link
                            href={`/meetings/${meeting.latest_capture_session_id}/report`}
                            style={{ fontFamily: sans, fontSize: 13, fontWeight: 700, color: "#fff", background: "var(--blue)", padding: "8px 16px", borderRadius: 999 }}
                          >
                            Open report
                          </Link>
                          <Link
                            href={`/meetings/${meeting.latest_capture_session_id}/correct`}
                            style={{ fontFamily: sans, fontSize: 13, fontWeight: 700, color: "var(--muted)", background: "var(--soft)", border: "1px solid var(--border)", padding: "8px 16px", borderRadius: 999 }}
                          >
                            Corrections
                          </Link>
                        </>
                      ) : (
                        <span style={{ fontSize: 12.5, color: "var(--faint)", alignSelf: "center" }}>
                          Capture session not ready yet
                        </span>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
