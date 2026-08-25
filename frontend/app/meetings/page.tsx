"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type { MeetingListItem } from "@/lib/types";

const serif = "'Source Serif 4', serif";
const mono = "'IBM Plex Mono', monospace";

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
      return { bg: "var(--accent-bg)", fg: "var(--accent-strong)", label: "Done" };
    case "failed":
      return { bg: "var(--gap-bg)", fg: "var(--gap)", label: "Failed" };
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
      return { bg: "var(--evidence-bg)", fg: "var(--evidence)", label: "Processing" };
    case "scheduled":
      return { bg: "var(--surface2)", fg: "var(--text-muted)", label: "Scheduled" };
    default:
      return { bg: "var(--surface2)", fg: "var(--text-faint)", label: state ?? "No capture yet" };
  }
}

export default function MeetingsPage() {
  const { me, authedFetch } = useAuth();
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);
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
  }, [me, authedFetch]);

  if (error) {
    return (
      <p style={{ margin: 32, borderRadius: 8, background: "var(--gap-bg)", border: "1px solid var(--gap)", padding: "8px 12px", fontSize: 14, color: "var(--gap)" }}>
        {error}
      </p>
    );
  }

  if (!me || meetings === null) {
    return <p style={{ fontSize: 14, color: "var(--text-muted)", padding: 32 }}>Loading meetings…</p>;
  }

  return (
    <div>
      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--border)" }}>
        <p style={{ fontFamily: serif, fontSize: 20, color: "var(--text)", margin: 0 }}>Meetings</p>
        <p style={{ fontSize: 13, color: "var(--text-faint)", margin: "6px 0 0" }}>
          Browse captured and scheduled meetings, then jump straight to their evidence-backed report.
        </p>
      </header>

      <main style={{ padding: "28px 32px 64px", maxWidth: 920 }}>
        {meetings.length === 0 ? (
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "22px 24px" }}>
            <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0 }}>
              No meetings yet. Upload a recording or connect a calendar to populate this list.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {meetings.map((meeting) => {
              const tone = stateTone(meeting.latest_capture_state);
              return (
                <article
                  key={meeting.id}
                  style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 22px" }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                        <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: "var(--text-faint)", border: "1px solid var(--border-strong)", padding: "3px 8px", borderRadius: 4, textTransform: "uppercase" }}>
                          {meeting.platform}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: tone.fg, background: tone.bg, padding: "3px 9px", borderRadius: 20 }}>
                          {tone.label}
                        </span>
                        {meeting.latest_bot_status && meeting.latest_capture_session_id === null && (
                          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--evidence)", background: "var(--evidence-bg)", padding: "3px 9px", borderRadius: 20 }}>
                            Bot {meeting.latest_bot_status.replaceAll("_", " ")}
                          </span>
                        )}
                        {meeting.has_coverage_gap && (
                          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--gap)", background: "var(--gap-bg)", padding: "3px 9px", borderRadius: 20 }}>
                            Coverage gap
                          </span>
                        )}
                      </div>
                      <p style={{ fontFamily: serif, fontSize: 18, color: "var(--text)", margin: "0 0 6px" }}>
                        {meeting.title}
                      </p>
                      <p style={{ fontSize: 13, color: "var(--text-faint)", margin: 0 }}>
                        {formatDate(meeting.scheduled_start)}
                      </p>
                      {meeting.latest_capture_error && (
                        <p style={{ fontSize: 12.5, color: "var(--gap)", margin: "10px 0 0" }}>
                          {meeting.latest_capture_error}
                        </p>
                      )}
                      {meeting.latest_bot_status === "failed" && meeting.latest_bot_error && (
                        <p style={{ fontSize: 12.5, color: "var(--gap)", margin: "10px 0 0", fontFamily: mono }}>
                          {meeting.latest_bot_error}
                        </p>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {meeting.latest_capture_session_id ? (
                        <>
                          <Link
                            href={`/meetings/${meeting.latest_capture_session_id}/report`}
                            style={{ fontSize: 13, fontWeight: 600, color: "#fff", background: "var(--accent-strong)", padding: "8px 14px", borderRadius: 7 }}
                          >
                            Open report
                          </Link>
                          <Link
                            href={`/meetings/${meeting.latest_capture_session_id}/correct`}
                            style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", border: "1px solid var(--border-strong)", padding: "8px 14px", borderRadius: 7 }}
                          >
                            Corrections
                          </Link>
                        </>
                      ) : (
                        <span style={{ fontSize: 12.5, color: "var(--text-faint)", alignSelf: "center" }}>
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
