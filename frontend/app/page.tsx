"use client";

// Ported from the Claude Design project "VisualSprint landing redesign" ->
// "VisualSprint App.dc.html". Authenticated Meetings dashboard, rendered as
// its own full layout (see lib/AppShell.tsx) rather than nested under the
// shared AppSidebar.
//
// This design uses its own token set (a literal blue primary, plus its own
// green/red) that is DIFFERENT from the app's teal/green tokens in
// globals.css that AppSidebar and every other page use -- kept as-is from
// the source design per instruction, rather than reconciled to the existing
// palette. Flag to design owner if that divergence is unintentional; until
// then, navigating from here into any other page is a visible style switch.
//
// No backend endpoint lists meetings or workspace stats yet (see
// backend/app/api/ -- upload.py, report.py, chat.py, people.py, actions.py
// exist; there is no meetings-list or dashboard-stats route). Everything
// below is therefore presentational mock content, not wired to a fetch --
// same "mock data boundary" as lib/mock-data.ts. Nav links route to the
// real pages that exist; "New capture" routes to the real /upload flow;
// the meeting rows and "Review queue" / workspace switcher are static
// (no per-meeting backend id to link to yet).

import Link from "next/link";

const T = {
  bg: "#ffffff",
  soft: "#f4f7fd",
  border: "#e7ecf5",
  borderStrong: "#dbe3f0",
  text: "#0f1729",
  muted: "#5a6478",
  faint: "#909cb0",
  blue: "#2563eb",
  blueStrong: "#1d4ed8",
  blueSoft: "#eef4ff",
  blueTint: "#dce9ff",
  amber: "#b3790f",
  amberSoft: "#fdf3de",
  green: "#0d7a5f",
  greenSoft: "#e4f6ef",
  red: "#c2410c",
  redSoft: "#fdece3",
  purple: "#5b5fc7",
  purpleSoft: "#eeeffc",
  shadow: "rgba(15,23,41,.07)",
  shadow2: "rgba(15,23,41,.12)",
};

const sans = "'Plus Jakarta Sans', sans-serif";
const mono = "'IBM Plex Mono', monospace";

type NavItem = { label: string; href: string; glyph: string; badge?: number };

const WORKSPACE_NAV: NavItem[] = [
  { label: "Meetings", href: "/", glyph: "M" },
  { label: "Org Chat", href: "/chat", glyph: "C" },
  { label: "Upload", href: "/upload", glyph: "U", badge: 1 },
  { label: "People", href: "/people", glyph: "P" },
  { label: "Actions", href: "/actions", glyph: "A", badge: 4 },
];

const SETUP_NAV: NavItem[] = [
  { label: "Connections", href: "/settings/connections", glyph: "S" },
  { label: "Vocabulary", href: "/glossary", glyph: "V", badge: 3 },
  { label: "Privacy & data", href: "/data-rights", glyph: "DR" },
];

type StatCard = { label: string; value: string; note: string; noteColor?: string; dark?: boolean };

const STATS: StatCard[] = [
  { label: "Decisions this week", value: "38", note: "92% verified", noteColor: T.green },
  { label: "Open commitments", value: "12", note: "3 past due", noteColor: T.amber },
  { label: "Capture coverage", value: "98.4%", note: "2 gaps disclosed", noteColor: T.muted },
];

type Platform = "ZOOM" | "MEET" | "TEAMS" | "UPLOAD";

const PLATFORM_STYLE: Record<Platform, { color: string; bg: string }> = {
  ZOOM: { color: T.blueStrong, bg: T.blueSoft },
  MEET: { color: T.green, bg: T.greenSoft },
  TEAMS: { color: T.purple, bg: T.purpleSoft },
  UPLOAD: { color: T.muted, bg: T.soft },
};

type MeetingStatus = "Ready" | "Verifying" | "Gap found";

const STATUS_COLOR: Record<MeetingStatus, string> = {
  Ready: T.green,
  Verifying: T.amber,
  "Gap found": T.red,
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

function NavButton({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "9px 10px",
        borderRadius: 9,
        fontFamily: sans,
        fontSize: 13.5,
        fontWeight: 600,
        textAlign: "left",
        whiteSpace: "nowrap",
        background: active ? T.blueSoft : "transparent",
        color: active ? T.blueStrong : T.muted,
        boxSizing: "border-box",
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          flexShrink: 0,
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: mono,
          fontSize: 10.5,
          fontWeight: 600,
          background: active ? "#ffffff" : T.soft,
          color: active ? T.blueStrong : T.faint,
        }}
      >
        {item.glyph}
      </span>
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.badge !== undefined && (
        <span
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            fontWeight: 600,
            color: T.faint,
            background: T.soft,
            borderRadius: 999,
            padding: "2px 7px",
          }}
        >
          {item.badge}
        </span>
      )}
    </Link>
  );
}

export default function MeetingsDashboardPage() {
  return (
    <div style={{ display: "flex", alignItems: "stretch", minHeight: "100vh", background: T.soft, fontFamily: sans }}>
      {/* Sidebar */}
      <aside
        style={{
          width: 244,
          flexShrink: 0,
          background: T.bg,
          borderRight: `1px solid ${T.border}`,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "18px 14px",
          boxSizing: "border-box",
          position: "sticky",
          top: 0,
          height: "100vh",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 8px 0", fontFamily: mono, fontSize: 15, fontWeight: 600, whiteSpace: "nowrap", marginBottom: 18 }}>
            <span style={{ color: T.blue }}>[</span>VisualSprint<span style={{ color: T.blue }}>]</span>
          </div>

          <div
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 9,
              background: T.soft,
              border: `1px solid ${T.border}`,
              borderRadius: 10,
              padding: "9px 11px",
              marginBottom: 16,
              boxSizing: "border-box",
            }}
          >
            <span style={{ width: 22, height: 22, borderRadius: 6, background: T.blue, color: "#fff", fontSize: 10.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              HL
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                Helios Labs
              </span>
              <span style={{ display: "block", fontFamily: mono, fontSize: 10, color: T.faint }}>team · 24 seats</span>
            </span>
            <span style={{ color: T.faint, fontSize: 10 }}>▾</span>
          </div>

          <p style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: T.faint, margin: "0 0 8px", padding: "0 10px" }}>
            Workspace
          </p>
          <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {WORKSPACE_NAV.map((item) => (
              <NavButton key={item.label} item={item} active={item.href === "/"} />
            ))}
          </nav>

          <p style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: T.faint, margin: "18px 0 8px", padding: "0 10px" }}>
            Setup
          </p>
          <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {SETUP_NAV.map((item) => (
              <NavButton key={item.label} item={item} active={false} />
            ))}
          </nav>
        </div>

        <div>
          <div style={{ background: T.blueSoft, border: `1px solid ${T.blueTint}`, borderRadius: 12, padding: "13px 14px", marginBottom: 12 }}>
            <p style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: T.blueStrong, margin: "0 0 6px" }}>
              Storage
            </p>
            <div style={{ height: 5, borderRadius: 999, background: "#fff", overflow: "hidden", marginBottom: 7 }}>
              <span style={{ display: "block", height: "100%", width: "62%", background: T.blue, borderRadius: 999 }} />
            </div>
            <p style={{ fontSize: 11.5, color: T.muted, margin: 0 }}>124 of 200 hrs processed</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, borderTop: `1px solid ${T.border}`, padding: "12px 6px 0" }}>
            <span style={{ width: 30, height: 30, borderRadius: "50%", background: T.text, color: "#fff", fontFamily: mono, fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              AS
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Anushka S.</span>
              <span style={{ display: "block", fontSize: 11, color: T.faint }}>Admin</span>
            </span>
            <span style={{ color: T.faint, fontSize: 12 }}>⚙</span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header
          style={{
            background: T.bg,
            borderBottom: `1px solid ${T.border}`,
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
            <p style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 500, letterSpacing: ".06em", textTransform: "uppercase", color: T.faint, margin: "0 0 3px" }}>
              Workspace
            </p>
            <h1 style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-.02em", margin: 0 }}>Meetings</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, background: T.soft, border: `1px solid ${T.border}`, borderRadius: 999, padding: "9px 15px", minWidth: 220 }}>
              <span style={{ color: T.faint, fontSize: 12 }}>⚲</span>
              <input
                type="text"
                placeholder="Search decisions, people, quotes"
                style={{ border: "none", background: "transparent", outline: "none", fontFamily: sans, fontSize: 13, color: T.text, width: "100%" }}
              />
            </label>
            <Link
              href="/upload"
              style={{
                fontFamily: sans,
                fontSize: 13.5,
                fontWeight: 700,
                color: "#fff",
                background: T.blue,
                borderRadius: 999,
                padding: "11px 20px",
                whiteSpace: "nowrap",
                boxShadow: `0 10px 22px -14px rgba(37,99,235,.8)`,
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
                <div key={s.label} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 16, padding: "18px 20px" }}>
                  <p style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: T.faint, margin: "0 0 10px" }}>
                    {s.label}
                  </p>
                  <p style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.03em", margin: "0 0 4px" }}>{s.value}</p>
                  <p style={{ fontSize: 12, color: s.noteColor, margin: 0, fontWeight: 600 }}>{s.note}</p>
                </div>
              ))}
              <div style={{ background: T.text, border: `1px solid ${T.text}`, borderRadius: 16, padding: "18px 20px" }}>
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

            <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap", padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                <p style={{ fontSize: 14.5, fontWeight: 700, margin: 0 }}>Recent meetings</p>
                <div style={{ display: "flex", gap: 7 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: T.blue, borderRadius: 999, padding: "6px 13px" }}>All</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: T.muted, background: T.soft, border: `1px solid ${T.border}`, borderRadius: 999, padding: "6px 13px" }}>
                    Processing
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: T.muted, background: T.soft, border: `1px solid ${T.border}`, borderRadius: 999, padding: "6px 13px" }}>
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
                      borderBottom: i < RECENT_MEETINGS.length - 1 ? `1px solid ${T.border}` : "none",
                      padding: "15px 20px",
                      boxSizing: "border-box",
                    }}
                  >
                    <span style={{ flex: "1 1 200px", minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {m.title}
                      </span>
                      <span style={{ display: "block", fontFamily: mono, fontSize: 11, color: T.faint, marginTop: 3 }}>
                        {m.when} · {m.duration}
                      </span>
                    </span>
                    <span style={{ flex: "0 0 auto", fontFamily: mono, fontSize: 11, fontWeight: 600, color: platform.color, background: platform.bg, borderRadius: 6, padding: "4px 8px" }}>
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
                            background: T.soft,
                            border: `1px solid ${T.border}`,
                            fontFamily: mono,
                            fontSize: 9.5,
                            fontWeight: 600,
                            color: T.muted,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          {a}
                        </span>
                      ))}
                      <span style={{ fontSize: 11.5, color: T.faint, whiteSpace: "nowrap" }}>+{m.overflow}</span>
                    </span>
                    <span style={{ flex: "0 0 auto", display: "flex", gap: 6 }}>
                      <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: T.blueStrong, background: T.blueSoft, borderRadius: 5, padding: "3px 7px", whiteSpace: "nowrap" }}>
                        {m.decisions} dec
                      </span>
                      <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: T.muted, background: T.soft, borderRadius: 5, padding: "3px 7px", whiteSpace: "nowrap" }}>
                        {m.commitments} com
                      </span>
                    </span>
                    <span style={{ flex: "0 0 84px", display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", fontSize: 12, fontWeight: 700, color: STATUS_COLOR[m.status], whiteSpace: "nowrap" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLOR[m.status], display: "inline-block" }} />
                      {m.status}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
