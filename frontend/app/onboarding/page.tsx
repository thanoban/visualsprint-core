"use client";

// Ported from the Claude Design project "Visualsprint core development" ->
// Onboarding.dc.html. The mockup's Individual/Team choice has nothing to
// persist to -- app.auth.dependency already auto-creates one personal org
// per user on first login (see app/api/me.py's docstring), and there's no
// Org field distinguishing "individual" vs "team" mode. This keeps the
// choice as a real, working navigation step (both paths land on the real
// app) without pretending to save a preference that doesn't exist on the
// backend yet.

import { useState } from "react";
import { useRouter } from "next/navigation";

const sans = "'Plus Jakarta Sans', sans-serif";
const serif = "'Plus Jakarta Sans', sans-serif";
const mono = "'IBM Plex Mono', monospace";

type Choice = "individual" | "team";

function Card({
  kicker,
  title,
  desc,
  items,
  selected,
  onClick,
}: {
  kicker: string;
  title: string;
  desc: string;
  items: string[];
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: sans,
        textAlign: "left",
        border: selected ? "2px solid var(--blue)" : "1px solid var(--border)",
        borderRadius: 12,
        padding: selected ? 21 : 22,
        background: "var(--bg)",
        cursor: "pointer",
        boxShadow: selected ? "0 12px 28px -14px var(--shadow)" : "none",
      }}
    >
      <span
        style={{
          fontFamily: mono,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.03em",
          textTransform: "uppercase",
          color: "var(--blue-strong)",
          background: "var(--blue-soft)",
          padding: "3px 9px",
          borderRadius: 4,
        }}
      >
        {kicker}
      </span>
      <p style={{ fontFamily: serif, fontSize: 19, color: "var(--text)", margin: "14px 0 6px" }}>{title}</p>
      <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--muted)", margin: "0 0 16px" }}>{desc}</p>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((item) => (
          <li key={item} style={{ fontSize: 13, color: "var(--muted)", display: "flex", gap: 8 }}>
            <span style={{ color: "var(--blue)" }}>✓</span>
            {item}
          </li>
        ))}
      </ul>
    </button>
  );
}

export default function OnboardingPage() {
  const [choice, setChoice] = useState<Choice>("individual");
  const router = useRouter();

  return (
    <div style={{ background: "var(--soft)", color: "var(--text)", fontFamily: sans, minHeight: "100vh" }}>
      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--border)" }}>
        <a href="/welcome" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontFamily: mono, color: "var(--blue)", fontWeight: 600 }}>[</span>
          <span style={{ fontFamily: serif, fontSize: 16, fontWeight: 600, color: "var(--text)" }}>VisualSprint</span>
          <span style={{ fontFamily: mono, color: "var(--blue)", fontWeight: 600 }}>]</span>
        </a>
      </header>

      <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 32px 80px" }}>
        <p style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase", color: "var(--blue-strong)", margin: "0 0 12px" }}>
          Set up your workspace
        </p>
        <h1 style={{ fontFamily: serif, fontSize: 34, color: "var(--text)", margin: "0 0 12px" }}>Who&apos;s this for?</h1>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--muted)", margin: "0 0 36px", maxWidth: 520 }}>
          You can invite teammates later either way — this just decides what your workspace looks like on day
          one.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Card
            kicker="Individual"
            title="Just me"
            desc="Your own meetings, remembered and searchable — no team setup, no member management."
            items={["Personal Google & Zoom connect", "Unlimited personal meetings", "Ask-your-memory chat, just for you"]}
            selected={choice === "individual"}
            onClick={() => setChoice("individual")}
          />
          <Card
            kicker="Team"
            title="Me and my team"
            desc="Shared org memory, connectors, and approvals across everyone who joins."
            items={["Org-wide memory chat", "Slack, Jira, GitHub, Linear connectors", "Verified automation approvals"]}
            selected={choice === "team"}
            onClick={() => setChoice("team")}
          />
        </div>

        <div style={{ marginTop: 36 }}>
          <button
            type="button"
            onClick={() => router.push("/")}
            style={{
              fontFamily: sans,
              display: "inline-block",
              fontSize: 15,
              fontWeight: 600,
              color: "#fff",
              background: "var(--blue-strong)",
              padding: "13px 24px",
              borderRadius: 7,
              border: "none",
              cursor: "pointer",
            }}
          >
            Continue as {choice === "individual" ? "Individual" : "a Team"} →
          </button>
          <p style={{ fontSize: 12.5, color: "var(--faint)", margin: "14px 0 0" }}>
            No card required · Invite teammates anytime from Settings
          </p>
        </div>
      </main>
    </div>
  );
}
