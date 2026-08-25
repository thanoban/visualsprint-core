"use client";

// Ported from the Claude Design project "VisualSprint landing redesign" ->
// "VisualSprint App.dc.html". Authenticated Meetings dashboard, rendered
// inside the shared AppShell (lib/AppSidebar.tsx provides the sidebar) --
// its blue accent is now the whole app's --accent token (see globals.css),
// so this page no longer needs its own copy of the sidebar or its own
// token set the way it originally did.
//
// No backend endpoint lists meetings or workspace stats yet (see
// backend/app/api/ -- upload.py, report.py, chat.py, people.py, actions.py
// exist; there is no meetings-list or dashboard-stats route). Everything
// below is therefore presentational mock content, not wired to a fetch --
// same "mock data boundary" as lib/mock-data.ts. "New capture" routes to
// the real /upload flow; the meeting rows are static (no per-meeting
// backend id to link to yet).

import Link from "next/link";

const sans = "'Plus Jakarta Sans', sans-serif";
const mono = "'IBM Plex Mono', monospace";

type StatCard = { label: string; value: string; note: string; noteVar: string };

const STATS: StatCard[] = [
  { label: "Decisions this week", value: "38", note: "92% verified", noteVar: "var(--success)" },
  { label: "Open commitments", value: "12", note: "3 past due", noteVar: "var(--evidence)" },
  { label: "Capture coverage", value: "98.4%", note: "2 gaps disclosed", noteVar: "var(--text-muted)" },
];

type Platform = "ZOOM" | "MEET" | "TEAMS" | "UPLOAD";

const PLATFORM_STYLE: Record<Platform, { colorVar: string; bgVar: string }> = {
  ZOOM: { colorVar: "var(--accent-strong)", bgVar: "var(--accent-bg)" },
  MEET: { colorVar: "var(--success)", bgVar: "var(--success-bg)" },
  TEAMS: { colorVar: "#5b5fc7", bgVar: "#eeeffc" },
  UPLOAD: { colorVar: "var(--text-muted)", bgVar: "var(--surface2)" },
};

type MeetingStatus = "Ready" | "Verifying" | "Gap found";

const STATUS_VAR: Record<MeetingStatus, string> = {
  Ready: "var(--success)",
  Verifying: "var(--evidence)",
  "Gap found": "var(--gap)",
};

type MeetingRow = {
  title: string;
  when: string;
  duration: string;
  platform: Platform;
  attendees: string[];
  overflow: number;
  decisions: number;
  commitments: number;
  status: MeetingStatus;
};

const RECENT_MEETINGS: MeetingRow[] = [
  {
    title: "Infrastructure Sync",
    when: "Jul 28, 10:00",
    duration: "48 min",
    platform: "ZOOM",
    attendees: ["NP", "DF", "AS"],
    overflow: 3,
    decisions: 4,
    commitments: 6,
    status: "Ready",
  },
  {
    title: "Q3 Roadmap Review",
    when: "Jul 27, 15:30",
    duration: "1 h 12 min",
    platform: "MEET",
    attendees: ["RK", "AS", "TM"],
    overflow: 8,
    decisions: 7,
    commitments: 9,
    status: "Ready",
  },
  {
    title: "Design Critique · Mobile",
    when: "Jul 27, 09:15",
    duration: "35 min",
    platform: "TEAMS",
    attendees: ["LM", "JP"],
    overflow: 2,
    decisions: 2,
    commitments: 3,
    status: "Verifying",
  },
  {
    title: "Vendor Call · Payments",
    when: "Jul 26, 14:00",
    duration: "52 min",
    platform: "UPLOAD",
    attendees: ["AS", "NP"],
    overflow: 1,
    decisions: 3,
    commitments: 2,
    status: "Gap found",
  },
];

export default function MeetingsDashboardPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: "var(--bg)", fontFamily: sans }}>
      <header
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          padding: "14px clamp(18px,3vw,30px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 18,
          flexWrap: "wrap",
          position: "sticky",
          top: 0,
          zIndex: 20,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 500, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text-faint)", margin: "0 0 3px" }}>
            Workspace
          </p>
          <h1 style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-.02em", margin: 0, color: "var(--text)" }}>Meetings</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 999, padding: "9px 15px", minWidth: 220 }}>
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>⚲</span>
            <input
              type="text"
              placeholder="Search decisions, people, quotes"
              style={{ border: "none", background: "transparent", outline: "none", fontFamily: sans, fontSize: 13, color: "var(--text)", width: "100%" }}
            />
          </label>
          <Link
            href="/upload"
            style={{
              fontFamily: sans,
              fontSize: 13.5,
              fontWeight: 700,
              color: "#fff",
              background: "var(--accent)",
              borderRadius: 999,
              padding: "11px 20px",
              whiteSpace: "nowrap",
            }}
          >
            New capture
          </Link>
        </div>
      </header>

      <main style={{ flex: 1, padding: "clamp(18px,3vw,28px) clamp(18px,3vw,30px) 56px" }}>
        <div style={{ maxWidth: 1140, margin: "0 auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 22 }}>
            {STATS.map((s) => (
              <div key={s.label} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: "18px 20px" }}>
                <p style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--text-faint)", margin: "0 0 10px" }}>
                  {s.label}
                </p>
                <p style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.03em", margin: "0 0 4px", color: "var(--text)" }}>{s.value}</p>
                <p style={{ fontSize: 12, color: s.noteVar, margin: 0, fontWeight: 600 }}>{s.note}</p>
              </div>
            ))}
            <div style={{ background: "var(--text)", border: "1px solid var(--text)", borderRadius: 16, padding: "18px 20px" }}>
              <p style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: "rgba(255,255,255,.55)", margin: "0 0 10px" }}>
                Awaiting approval
              </p>
              <p style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.03em", margin: "0 0 4px", color: "#fff" }}>4</p>
              <Link
                href="/actions"
                style={{
                  display: "inline-block",
                  fontFamily: sans,
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#fff",
                  background: "rgba(255,255,255,.16)",
                  borderRadius: 999,
                  padding: "5px 12px",
                }}
              >
                Review queue
              </Link>
            </div>
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap", padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
              <p style={{ fontSize: 14.5, fontWeight: 700, margin: 0, color: "var(--text)" }}>Recent meetings</p>
              <div style={{ display: "flex", gap: 7 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: "var(--accent)", borderRadius: 999, padding: "6px 13px" }}>All</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 999, padding: "6px 13px" }}>
                  Processing
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 999, padding: "6px 13px" }}>
                  Needs review
                </span>
              </div>
            </div>

            {RECENT_MEETINGS.map((m, i) => {
              const platform = PLATFORM_STYLE[m.platform];
              return (
                <div
                  key={m.title}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: "12px 16px",
                    width: "100%",
                    borderBottom: i < RECENT_MEETINGS.length - 1 ? "1px solid var(--border)" : "none",
                    padding: "15px 20px",
                    boxSizing: "border-box",
                  }}
                >
                  <span style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {m.title}
                    </span>
                    <span style={{ display: "block", fontFamily: mono, fontSize: 11, color: "var(--text-faint)", marginTop: 3 }}>
                      {m.when} · {m.duration}
                    </span>
                  </span>
                  <span style={{ flex: "0 0 auto", fontFamily: mono, fontSize: 11, fontWeight: 600, color: platform.colorVar, background: platform.bgVar, borderRadius: 6, padding: "4px 8px" }}>
                    {m.platform}
                  </span>
                  <span style={{ flex: "0 1 auto", display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
                    {m.attendees.map((a, idx) => (
                      <span
                        key={idx}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: "50%",
                          background: "var(--surface2)",
                          border: "1px solid var(--border)",
                          fontFamily: mono,
                          fontSize: 9.5,
                          fontWeight: 600,
                          color: "var(--text-muted)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        {a}
                      </span>
                    ))}
                    <span style={{ fontSize: 11.5, color: "var(--text-faint)", whiteSpace: "nowrap" }}>+{m.overflow}</span>
                  </span>
                  <span style={{ flex: "0 0 auto", display: "flex", gap: 6 }}>
                    <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: "var(--accent-strong)", background: "var(--accent-bg)", borderRadius: 5, padding: "3px 7px", whiteSpace: "nowrap" }}>
                      {m.decisions} dec
                    </span>
                    <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: "var(--text-muted)", background: "var(--surface2)", borderRadius: 5, padding: "3px 7px", whiteSpace: "nowrap" }}>
                      {m.commitments} com
                    </span>
                  </span>
                  <span style={{ flex: "0 0 84px", display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", fontSize: 12, fontWeight: 700, color: STATUS_VAR[m.status], whiteSpace: "nowrap" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_VAR[m.status], display: "inline-block" }} />
                    {m.status}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
