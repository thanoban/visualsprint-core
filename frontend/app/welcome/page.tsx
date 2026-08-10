"use client";

// Ported from the Claude Design project "Visualsprint core development" ->
// Landing.dc.html. Public marketing page, not part of the authenticated app
// shell -- see lib/AuthProvider.tsx's PUBLIC_PATHS. The design's own CTAs
// all point at Login.dc.html, so this stays a separate route from "/" (the
// authenticated meetings dashboard) rather than replacing it -- changing
// what "/" means for already-signed-in users wasn't part of this ask.

import { useState } from "react";

const LIGHT = {
  bg: "#f6f4ee",
  surface: "#ffffff",
  surface2: "#efece2",
  border: "#e1ddd0",
  borderStrong: "#cfc9b8",
  text: "#14171d",
  textMuted: "#6b6558",
  textFaint: "#948d7c",
  accent: "#1f7a5c",
  accentBg: "#e3f1ea",
  accentStrong: "#145c44",
  evidence: "#b3790f",
  evidenceBg: "#f8edd6",
  gap: "#ab4a2f",
  gapBg: "#f6e6df",
  accentDarkBand: "#5cd1ab",
};
const DARK = {
  bg: "#0c0f14",
  surface: "#151a22",
  surface2: "#1b212b",
  border: "#272e3a",
  borderStrong: "#333c4a",
  text: "#eae6dc",
  textMuted: "#a39c8a",
  textFaint: "#726c5c",
  accent: "#3ab892",
  accentBg: "rgba(58,184,146,0.14)",
  accentStrong: "#5cd1ab",
  evidence: "#e0a83e",
  evidenceBg: "rgba(224,168,62,0.16)",
  gap: "#dd8563",
  gapBg: "rgba(221,133,99,0.16)",
  accentDarkBand: "#5cd1ab",
};

const sans = "'IBM Plex Sans', sans-serif";
const serif = "'Source Serif 4', serif";
const mono = "'IBM Plex Mono', monospace";

const LOOP_STEPS = [
  { n: "01", title: "Capture", desc: "Zoom RTMS, Meet/Teams recordings, or direct upload — official APIs, no bot in the room." },
  { n: "02", title: "Understand", desc: "Trilingual ASR cascade extracts decisions, commitments, blockers, and facts." },
  { n: "03", title: "Verify", desc: "An independent pass checks every claim against transcript and screen evidence." },
  { n: "04", title: "Remember", desc: "Verified items join searchable, lifecycle-aware organizational memory." },
  { n: "05", title: "Act", desc: "Recaps, tasks, and follow-ups are proposed — never sent without your approval." },
];

const COMPARE_ROWS = [
  { label: "Sinhala/Tamil code-switching", them: "Not supported", us: "Native, day one" },
  { label: "Speech ↔ screen grounding", them: "Not offered", us: "Every keyframe linked" },
  { label: "Capture-coverage honesty", them: "Silent gaps", us: "Disclosed plainly" },
  { label: "Cross-meeting memory", them: "Single-meeting only", us: "Org-wide, cited" },
];

const LOGO_NAMES = ["Cinnamon Labs", "Orbit Systems", "Kandy Robotics", "Wavelet.io", "Meridian Health"];

function pricingTiers(billing: "annual" | "monthly") {
  return [
    {
      name: "Individual",
      price: billing === "annual" ? "$9" : "$12",
      blurb: "One person, their own meetings.",
      features: ["1 seat", "Personal meetings only", "Google & Zoom personal connect", "14-day memory retention"],
      cta: "Start free trial",
      highlight: false,
    },
    {
      name: "Starter",
      price: billing === "annual" ? "$14" : "$18",
      blurb: "Small teams getting off group chat memory.",
      features: ["Up to 10 seats", "Unlimited meetings", "Trilingual transcription", "30-day memory retention"],
      cta: "Start free trial",
      highlight: false,
    },
    {
      name: "Team",
      price: billing === "annual" ? "$29" : "$36",
      blurb: "For teams that need org memory that never resets.",
      features: ["Unlimited seats", "Full evidence grounding", "Org-memory chat", "Unlimited retention", "Automation approvals"],
      cta: "Start free trial",
      highlight: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      blurb: "Data residency, SSO, and dedicated support.",
      features: ["Everything in Team", "Regional data residency", "SSO / SCIM", "Dedicated success manager"],
      cta: "Talk to us",
      highlight: false,
    },
  ];
}

function kicker(color: string): React.CSSProperties {
  return {
    fontFamily: mono,
    fontSize: 12.5,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color,
    margin: "0 0 12px",
  };
}

export default function WelcomePage() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [billing, setBilling] = useState<"annual" | "monthly">("annual");
  const t = theme === "dark" ? DARK : LIGHT;
  const sectionInner: React.CSSProperties = { maxWidth: 1180, margin: "0 auto", padding: "0 32px" };
  const sectionHeadline: React.CSSProperties = {
    fontFamily: serif,
    fontSize: 34,
    lineHeight: 1.22,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    color: t.text,
    margin: "0 0 20px",
    maxWidth: 680,
  };
  const sectionSub: React.CSSProperties = { fontSize: 15.5, lineHeight: 1.65, color: t.textMuted, margin: "0 0 36px" };

  return (
    <div style={{ background: t.bg, color: t.text, fontFamily: sans, minHeight: "100vh", transition: "background .2s" }}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: t.bg,
          borderBottom: `1px solid ${t.border}`,
        }}
      >
        <div style={{ ...sectionInner, padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: mono, fontSize: 20, color: t.accent, fontWeight: 600 }}>[</span>
            <span style={{ fontFamily: serif, fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", color: t.text }}>
              VisualSprint
            </span>
            <span style={{ fontFamily: mono, fontSize: 20, color: t.accent, fontWeight: 600 }}>]</span>
          </div>
          <nav style={{ display: "flex", alignItems: "center", gap: 22 }}>
            <a href="#how-it-works" style={{ fontSize: 14, fontWeight: 500, color: t.textMuted, whiteSpace: "nowrap" }}>How it works</a>
            <a href="#evidence" style={{ fontSize: 14, fontWeight: 500, color: t.textMuted, whiteSpace: "nowrap" }}>Evidence</a>
            <a href="#compare" style={{ fontSize: 14, fontWeight: 500, color: t.textMuted, whiteSpace: "nowrap" }}>Comparison</a>
            <a href="#pricing" style={{ fontSize: 14, fontWeight: 500, color: t.textMuted, whiteSpace: "nowrap" }}>Pricing</a>
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              style={{
                fontFamily: sans,
                fontSize: 13,
                fontWeight: 500,
                color: t.textMuted,
                background: t.surface2,
                border: `1px solid ${t.border}`,
                borderRadius: 6,
                padding: "7px 12px",
                cursor: "pointer",
              }}
            >
              {theme === "dark" ? "☀ Light" : "● Dark"}
            </button>
            <a
              href="/login"
              style={{ fontFamily: sans, fontSize: 13.5, fontWeight: 600, color: "#fff", background: t.accentStrong, padding: "9px 16px", borderRadius: 6 }}
            >
              Start free trial
            </a>
          </div>
        </div>
      </header>

      <main>
        <section style={{ padding: "72px 0 88px" }}>
          <div style={{ ...sectionInner, position: "relative", overflow: "hidden" }}>
            <span
              style={{
                position: "absolute",
                top: -60,
                right: 0,
                fontFamily: serif,
                fontSize: 360,
                lineHeight: 1,
                color: t.accent,
                opacity: 0.07,
                pointerEvents: "none",
                userSelect: "none",
                zIndex: 0,
              }}
            >
              [
            </span>
            <div style={{ position: "relative", zIndex: 1, maxWidth: 700 }}>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 12.5,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  color: t.accentStrong,
                  background: t.accentBg,
                  display: "inline-block",
                  padding: "6px 12px",
                  borderRadius: 5,
                  marginBottom: 22,
                }}
              >
                [ Built natively for Sinhala · Tamil · English ]
              </div>
              <h1 style={{ fontFamily: serif, fontSize: 46, lineHeight: 1.12, fontWeight: 600, letterSpacing: "-0.015em", color: t.text, margin: "0 0 20px" }}>
                Meetings, remembered exactly as they happened.
              </h1>
              <p style={{ fontSize: 16.5, lineHeight: 1.65, color: t.textMuted, margin: 0 }}>
                Evidence-grounded organizational memory from Zoom, Meet, and Teams — every claim traced to a
                speaker, a transcript span, and the screen on display at that moment.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 22 }}>
                {["Evidence-grounded, not just transcribed", "Sinhala · Tamil · English, mid-sentence", "Speech ↔ screen, linked"].map((tag) => (
                  <span
                    key={tag}
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: t.textMuted,
                      background: t.surface,
                      border: `1px solid ${t.border}`,
                      padding: "6px 12px",
                      borderRadius: 20,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", gap: 14, marginTop: 32 }}>
                <a
                  href="/login"
                  style={{ fontFamily: sans, fontSize: 15, fontWeight: 600, color: "#fff", background: t.accentStrong, padding: "14px 26px", borderRadius: 7 }}
                >
                  Start free trial
                </a>
                <a
                  href="#evidence"
                  style={{ fontFamily: sans, fontSize: 15, fontWeight: 500, color: t.text, background: "transparent", padding: "14px 20px", border: `1px solid ${t.borderStrong}`, borderRadius: 7 }}
                >
                  See a real report ↓
                </a>
              </div>
              <p style={{ fontSize: 13, color: t.textFaint, marginTop: 16 }}>
                No card required · Live in under 10 minutes · SOC2-track, PDPA-ready
              </p>
            </div>
          </div>
        </section>

        <section style={{ padding: "88px 0", background: t.surface2 }}>
          <div style={sectionInner}>
            <p style={kicker(t.accentStrong)}>The problem</p>
            <h2 style={sectionHeadline}>Half your meeting&apos;s context lives in what generic tools can&apos;t hear.</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, padding: 22 }}>
                <p style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 600, color: t.textFaint, textTransform: "uppercase", letterSpacing: "0.03em", margin: "0 0 14px" }}>
                  Generic English-only transcript
                </p>
                <p style={{ fontSize: 15, lineHeight: 1.7, color: t.textFaint, fontStyle: "italic", margin: 0 }}>
                  &quot;So [inaudible] we should probably [inaudible] the database, um, [inaudible] performance side
                  is [inaudible] worth it...&quot;
                </p>
                <p style={{ fontSize: 12, color: t.gap, marginTop: 14 }}>
                  ⚠ Code-switched spans dropped or garbled — the actual decision never survives.
                </p>
              </div>
              <div style={{ background: t.surface, border: `1px solid ${t.accent}`, borderRadius: 10, padding: 22 }}>
                <p style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 600, color: t.accentStrong, textTransform: "uppercase", letterSpacing: "0.03em", margin: "0 0 14px" }}>
                  VisualSprint transcript
                </p>
                <p style={{ fontSize: 15, lineHeight: 1.7, color: t.text, margin: 0 }}>
                  &quot;MongoDB එකෙන් අයින් වෙලා pgvector <span style={{ color: t.textFaint }}>[EN]</span> එක්ක
                  PostgreSQL-ට switch වෙන්න ඕන — vector search performance එක ගොඩක් හොඳ වෙනවා.&quot;
                </p>
                <p style={{ fontSize: 12, color: t.accentStrong, marginTop: 14 }}>
                  ✓ Full sentence captured, language-tagged, and traced to this exact moment.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section id="how-it-works" style={{ padding: "88px 0", background: "#12161c" }}>
          <div style={sectionInner}>
            <p style={kicker(t.accentDarkBand)}>How it works</p>
            <h2 style={{ ...sectionHeadline, color: "#f2efe6" }}>One loop, five verifiable steps.</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 20, position: "relative", marginTop: 12 }}>
              {LOOP_STEPS.map((step) => (
                <div key={step.n} style={{ borderTop: "2px solid #333c47", paddingTop: 20 }}>
                  <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, color: "#5cd1ab" }}>{step.n}</span>
                  <h3 style={{ fontFamily: serif, fontSize: 19, color: "#f2efe6", margin: "14px 0 8px" }}>{step.title}</h3>
                  <p style={{ fontSize: 14, lineHeight: 1.55, color: "#a8a290", margin: 0 }}>{step.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="evidence" style={{ padding: "88px 0", background: t.bg }}>
          <div style={sectionInner}>
            <p style={kicker(t.accentStrong)}>Evidence-grounding</p>
            <h2 style={sectionHeadline}>Every answer cites a speaker, a quote, and a screen.</h2>
            <p style={sectionSub}>
              Six months from now, someone will ask &quot;why are we using PostgreSQL instead of MongoDB?&quot;
              This is the traced answer they&apos;ll get — pulled from three meetings, not one person&apos;s
              memory.
            </p>

            <div style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 12, padding: 26 }}>
              <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#6b6558", color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: mono }}>
                  RJ
                </div>
                <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, padding: "12px 16px", fontSize: 14.5, color: t.text, alignSelf: "flex-start" }}>
                  Why are we using PostgreSQL instead of MongoDB now?
                </div>
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: t.accent, color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: mono }}>
                  VS
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ margin: "0 0 12px", fontSize: 14.5, lineHeight: 1.65, color: t.text }}>
                    The decision was made in <strong>Infra Sync — Jul 28</strong>{" "}
                    <a href="#cite1" style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, color: t.accentStrong, background: t.accentBg, padding: "1px 5px", borderRadius: 3 }}>
                      [1]
                    </a>
                    , driven by pgvector&apos;s hybrid search performance under load. It was reaffirmed twice —
                    once when the migration plan was scoped{" "}
                    <a href="#cite2" style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, color: t.accentStrong, background: t.accentBg, padding: "1px 5px", borderRadius: 3 }}>
                      [2]
                    </a>
                    , and once when Dinesh flagged a rollback risk that the team accepted{" "}
                    <a href="#cite3" style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, color: t.accentStrong, background: t.accentBg, padding: "1px 5px", borderRadius: 3 }}>
                      [3]
                    </a>
                    .
                  </p>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {[
                      { label: "[1] Nimal Perera · 04:05", quote: "\"...pgvector එක්ක switch වෙන්න ඕන...\"", tag: "SI+EN", tagColor: t.accentStrong, tagBg: t.accentBg },
                      { label: "[2] Kavindi Silva · 12:40", quote: '"Migration plan is two weeks, staged by tenant."', tag: "EN", tagColor: t.textFaint, tagBg: t.surface2 },
                      { label: "[3] Dinesh Fernando · 03:12", quote: '"ரோல்பேக் பிளான் வேணும் முதல்ல."', tag: "TA+EN", tagColor: t.evidence, tagBg: t.evidenceBg },
                    ].map((c) => (
                      <div key={c.label} style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 8, padding: "11px 13px", maxWidth: 220 }}>
                        <p style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: t.textFaint, margin: "0 0 6px" }}>{c.label}</p>
                        <p style={{ fontSize: 12.5, lineHeight: 1.5, color: t.textMuted, margin: 0 }}>
                          {c.quote}{" "}
                          <span style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, color: c.tagColor, background: c.tagBg, padding: "1px 6px", borderRadius: 3, marginLeft: 6 }}>
                            {c.tag}
                          </span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section style={{ padding: "88px 0", background: t.surface }}>
          <div style={sectionInner}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 56, alignItems: "center" }}>
              <div>
                <p style={kicker(t.accentStrong)}>Capture-coverage honesty</p>
                <h2 style={{ ...sectionHeadline, fontSize: 32 }}>If we missed something, we say so.</h2>
                <p style={{ ...sectionSub, maxWidth: 480 }}>
                  Every other tool presents its record as complete. When a mic is muted or a screen-share drops,
                  VisualSprint discloses the exact gap — because a trustworthy partial record beats a confident
                  false one.
                </p>
              </div>
              <div style={{ background: t.gapBg, border: `1px solid ${t.gap}`, borderRadius: 10, padding: "20px 22px" }}>
                <span style={{ fontFamily: mono, fontSize: 13, color: t.gap, fontWeight: 600 }}>
                  ⚠ Coverage gap · 11:42–11:44
                </span>
                <p style={{ fontSize: 14, lineHeight: 1.55, color: t.textMuted, margin: "8px 0 0" }}>
                  Audio not captured (participant mic muted). Knowledge items overlapping this interval are
                  flagged below and excluded from confidence scoring.
                </p>
              </div>
            </div>

            <div>
              <p style={{ ...kicker(t.accentStrong), marginTop: 56 }}>Verified automation</p>
              <h2 style={{ ...sectionHeadline, fontSize: 32 }}>Nothing sends without your approval.</h2>
              <div style={{ background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, padding: "20px 22px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20, marginTop: 24 }}>
                <div>
                  <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: t.textFaint, border: `1px solid ${t.borderStrong}`, padding: "3px 8px", borderRadius: 4 }}>
                    Slack recap
                  </span>
                  <p style={{ fontSize: 14.5, color: t.text, margin: "10px 0 4px", fontWeight: 500 }}>
                    Post migration-decision recap to #infra
                  </p>
                  <p style={{ fontSize: 13, color: t.textFaint, margin: 0 }}>
                    Based on 3 verified knowledge items · Infra Sync, Jul 28
                  </p>
                </div>
                <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
                  <button
                    type="button"
                    style={{ fontFamily: sans, fontSize: 13.5, fontWeight: 600, color: t.textMuted, background: "transparent", border: `1px solid ${t.borderStrong}`, padding: "9px 16px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    style={{ fontFamily: sans, fontSize: 13.5, fontWeight: 600, color: "#fff", background: t.accentStrong, border: "none", padding: "9px 16px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    Approve
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="compare" style={{ padding: "88px 0", background: t.bg }}>
          <div style={sectionInner}>
            <p style={kicker(t.accentStrong)}>Where VisualSprint is different</p>
            <h2 style={sectionHeadline}>Parity on the commodity. Category-defining on the rest.</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 16 }}>
              {COMPARE_ROWS.map((row) => (
                <div key={row.label} style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 22, background: t.surface }}>
                  <p style={{ fontFamily: serif, fontSize: 17, color: t.text, margin: "0 0 16px" }}>{row.label}</p>
                  <div style={{ paddingBottom: 14, marginBottom: 14, borderBottom: `1px solid ${t.border}` }}>
                    <span style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", color: t.textFaint }}>
                      Otter / Fireflies / Fathom
                    </span>
                    <p style={{ fontSize: 14, color: t.textFaint, margin: "6px 0 0" }}>{row.them}</p>
                  </div>
                  <div>
                    <span style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", color: t.accentStrong }}>
                      VisualSprint
                    </span>
                    <p style={{ fontSize: 14.5, fontWeight: 600, color: t.accentStrong, margin: "6px 0 0" }}>✓ {row.us}</p>
                  </div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 13, color: t.textFaint, marginTop: 18 }}>
              A transcript, auto-join, and a tidy summary are commodity now — every platform bundles them free.
              We match that, then spend the effort where it structurally can&apos;t be copied.
            </p>
          </div>
        </section>

        <section id="pricing" style={{ padding: "88px 0", background: t.surface }}>
          <div style={sectionInner}>
            <p style={kicker(t.accentStrong)}>Pricing</p>
            <h2 style={sectionHeadline}>Straightforward, per active seat.</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "8px 0 32px" }}>
              <span style={{ fontSize: 14, color: billing === "monthly" ? t.text : t.textFaint, fontWeight: 500 }}>Monthly</span>
              <button
                type="button"
                onClick={() => setBilling(billing === "annual" ? "monthly" : "annual")}
                style={{ width: 40, height: 22, borderRadius: 20, background: t.accent, border: "none", position: "relative", cursor: "pointer", padding: 0 }}
              >
                <span
                  style={{
                    position: "absolute",
                    top: 2,
                    left: billing === "annual" ? 20 : 2,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "#fff",
                    transition: "left .15s",
                    display: "block",
                  }}
                />
              </button>
              <span style={{ fontSize: 14, color: billing === "annual" ? t.text : t.textFaint, fontWeight: 500 }}>
                Annual <span style={{ color: t.accentStrong }}>— 2 months free</span>
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
              {pricingTiers(billing).map((tier) => (
                <div
                  key={tier.name}
                  style={
                    tier.highlight
                      ? { border: `2px solid ${t.accent}`, borderRadius: 12, padding: 26, background: t.bg, boxShadow: `0 16px 32px -14px ${LIGHT.textFaint}22` }
                      : { border: `1px solid ${t.border}`, borderRadius: 12, padding: 26, background: t.bg }
                  }
                >
                  <p style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 600, color: t.textFaint, textTransform: "uppercase", letterSpacing: "0.03em", margin: "0 0 10px" }}>
                    {tier.name}
                  </p>
                  <p style={{ fontFamily: serif, fontSize: 32, fontWeight: 600, color: t.text, margin: 0 }}>
                    {tier.price}
                    <span style={{ fontSize: 14, fontWeight: 400, color: t.textFaint }}>/seat/mo</span>
                  </p>
                  <p style={{ fontSize: 13, color: t.textMuted, margin: "2px 0 20px" }}>{tier.blurb}</p>
                  {tier.features.map((f) => (
                    <p key={f} style={{ fontSize: 13.5, color: t.textMuted, margin: "0 0 9px", display: "flex", gap: 8 }}>
                      <span style={{ color: t.accent }}>✓</span>
                      {f}
                    </p>
                  ))}
                  <a
                    href="/login"
                    style={
                      tier.highlight
                        ? { fontFamily: sans, width: "100%", fontSize: 14, fontWeight: 600, color: "#fff", background: t.accentStrong, border: "none", padding: 11, borderRadius: 7, cursor: "pointer", display: "block", textAlign: "center", boxSizing: "border-box" }
                        : { fontFamily: sans, width: "100%", fontSize: 14, fontWeight: 600, color: t.text, background: t.surface2, border: `1px solid ${t.borderStrong}`, padding: 11, borderRadius: 7, cursor: "pointer", display: "block", textAlign: "center", boxSizing: "border-box" }
                    }
                  >
                    {tier.cta}
                  </a>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section style={{ padding: "88px 0 56px", background: t.bg }}>
          <div style={sectionInner}>
            <div style={{ display: "flex", justifyContent: "center", gap: 14, flexWrap: "wrap" }}>
              {["PDPA-ready data handling", "Per-org data residency", "Audio stored, never silently deleted", "Export & erase on request"].map((label) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: t.textMuted, background: t.surface, border: `1px solid ${t.border}`, padding: "9px 14px", borderRadius: 20, whiteSpace: "nowrap" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: t.accent, display: "inline-block" }} />
                  {label}
                </div>
              ))}
            </div>
            <p style={{ textAlign: "center", fontSize: 13, color: t.textFaint, margin: "36px 0 20px" }}>
              Trusted by engineering and product teams building in Sri Lanka and beyond
            </p>
            <div style={{ display: "flex", justifyContent: "center", gap: 48, flexWrap: "wrap", opacity: 0.75 }}>
              {LOGO_NAMES.map((ln) => (
                <span key={ln} style={{ fontFamily: serif, fontSize: 18, color: t.textFaint, fontWeight: 600, letterSpacing: "-0.01em" }}>
                  {ln}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section style={{ padding: "96px 0", background: "#12161c" }}>
          <div style={{ ...sectionInner, textAlign: "center" }}>
            <h2 style={{ fontFamily: serif, fontSize: 38, color: "#f2efe6", margin: "0 0 16px" }}>
              Stop losing decisions to memory.
            </h2>
            <p style={{ fontSize: 16, color: "#a8a290", maxWidth: 520, margin: "0 auto 28px" }}>
              Start free. First report generates from your next meeting — in whichever languages your team
              actually speaks.
            </p>
            <a
              href="/login"
              style={{ fontFamily: sans, fontSize: 15, fontWeight: 600, color: "#fff", background: t.accentStrong, padding: "14px 26px", borderRadius: 7, display: "inline-block" }}
            >
              Start free trial
            </a>
          </div>
        </section>
      </main>

      <footer style={{ padding: "28px 0", background: t.bg, borderTop: `1px solid ${t.border}` }}>
        <div style={{ ...sectionInner, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: mono, color: t.accent }}>[</span>
            <span style={{ fontFamily: serif, fontSize: 15, color: t.text }}>VisualSprint</span>
            <span style={{ fontFamily: mono, color: t.accent }}>]</span>
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            <a href="/chat" style={{ fontSize: 13, color: t.textFaint }}>Org memory chat</a>
            <a href="/upload" style={{ fontSize: 13, color: t.textFaint }}>Upload</a>
            <a href="/actions" style={{ fontSize: 13, color: t.textFaint }}>Actions</a>
            <a href="/settings/connections" style={{ fontSize: 13, color: t.textFaint }}>Connections</a>
          </div>
          <p style={{ fontSize: 12, color: t.textFaint, margin: 0 }}>© 2026 VisualSprint. Evidence-grounded meeting intelligence.</p>
        </div>
      </footer>
    </div>
  );
}
