"use client";

// Ported from the Claude Design project "VisualSprint landing redesign" ->
// VisualSprint Landing v1.dc.html. Public marketing page, not part of the
// authenticated app shell -- see lib/AuthProvider.tsx's PUBLIC_PATHS.
//
// This design uses its own token set (lime accent, warm cream ground) that
// is DIFFERENT from the authenticated app's teal/green design tokens in
// globals.css -- that divergence is preserved as-is from the source design
// rather than silently reconciled, since the marketing site and the product
// UI are allowed to be distinct surfaces. Flag to design owner if that's
// unintentional.
//
// CTAs that in the source design point at placeholder anchors are mapped to
// real destinations: "Sign in" goes to the actual working signup at /login.
// "Book a demo" and "Collaborate with us" open the LeadModal below, which
// POSTs to /api/v1/leads (app/api/leads.py, backend) -- a real, unauthenticated
// endpoint backed by the landing_lead table, not a fabricated waitlist.
//
// Screenshot slots: four of the five (.dc.html image-slot elements, plus one
// added beyond the source design) have real product screenshots at
// public/landing/vs-shot-*.webp -- see that directory's provenance in the
// commit history if the images ever need re-cropping from source.

import { useState } from "react";
import { API_BASE_URL } from "@/lib/config";

const LIGHT = {
  bg: "#f7f6f2",
  surface: "#ffffff",
  surface2: "#f0eee7",
  border: "#e4e1d8",
  borderStrong: "#cdc9bd",
  text: "#15171b",
  muted: "#5d6270",
  faint: "#8a8f9c",
  accent: "#c6f24e",
  accentText: "#46620a",
  accentSoft: "#eef7cf",
  btnBg: "#15171b",
  btnFg: "#f7f6f2",
  evidence: "#a8720c",
  evidenceBg: "#fbf0d8",
  gap: "#b34724",
  gapBg: "#fae8e0",
  lang: "#3b5bd0",
  langBg: "#e7ebfb",
  band: "#111318",
  bandSurface: "#191c23",
  bandText: "#f4f2ec",
  bandMuted: "#9aa0ac",
  bandBorder: "#282c35",
  shadow: "rgba(20,23,29,.09)",
};

const DARK = {
  bg: "#0a0b0f",
  surface: "#12141a",
  surface2: "#191c23",
  border: "#242832",
  borderStrong: "#343a46",
  text: "#f1efea",
  muted: "#9ba0ac",
  faint: "#6e7381",
  accent: "#c6f24e",
  accentText: "#c6f24e",
  accentSoft: "rgba(198,242,78,.13)",
  btnBg: "#c6f24e",
  btnFg: "#0a0b0f",
  evidence: "#f0b23c",
  evidenceBg: "rgba(240,178,60,.15)",
  gap: "#ff8a66",
  gapBg: "rgba(255,138,102,.15)",
  lang: "#9db2ff",
  langBg: "rgba(157,178,255,.14)",
  band: "#0f1116",
  bandSurface: "#161a21",
  bandText: "#f1efea",
  bandMuted: "#9ba0ac",
  bandBorder: "#22262f",
  shadow: "rgba(0,0,0,.5)",
};

const serif = "'Source Serif 4', serif";
const sans = "'IBM Plex Sans', sans-serif";
const mono = "'IBM Plex Mono', monospace";

const PIPELINE = [
  { n: "01", title: "Capture", body: "Audio, speaker tracks and screen keyframes via official platform APIs." },
  { n: "02", title: "Understand", body: "Transcription across mixed languages, then decisions, commitments and blockers." },
  { n: "03", title: "Verify", body: "An independent pass re-checks every claim against transcript and screen evidence." },
  { n: "04", title: "Remember", body: "Verified items enter org memory, with reaffirmations and reversals tracked." },
  { n: "05", title: "Act", body: "Recaps, tickets and follow-ups are drafted, then approved by a person." },
];

const PROOF_SCREENS = [
  {
    tag: "Screen 01",
    title: "The meeting report",
    body: "Decisions, commitments and blockers — each with a confidence score, its source quote, and the screen it came from.",
    points: [
      "Confidence badge per knowledge item",
      "Inline screen-evidence thumbnails",
      "Coverage-gap disclosure",
    ],
    url: "app.visualsprint.io/meetings/infra-sync-jul28/report",
    footer: "report view",
    img: "/landing/vs-shot-report.webp",
  },
  {
    tag: "Screen 02",
    title: "Org-memory chat",
    body: "Ask across your full meeting history. Every sentence in the answer carries a citation you can open.",
    points: [
      "Answers span months of history",
      "Source quotes stay verbatim",
      "Jump straight to the source timestamp",
    ],
    url: "app.visualsprint.io/chat",
    footer: "org-memory chat",
    img: "/landing/vs-shot-chat.webp",
  },
  {
    tag: "Screen 03",
    title: "Capture & upload",
    body: "Drop a recording and follow it through all five stages with live status.",
    points: [
      "Stage-by-stage pipeline status",
      "Detected language mix per segment",
      "Failures surface instead of retrying silently",
    ],
    url: "app.visualsprint.io/upload",
    footer: "capture pipeline",
    img: "/landing/vs-shot-upload.webp",
  },
  {
    tag: "Screen 04",
    title: "Connections",
    body: "Connect your own Zoom, Google and Microsoft accounts, plus where verified work goes: Jira, Linear, GitHub, Slack.",
    points: [
      "Nothing routes through a shared account",
      "Tasks open only from verified commitments",
      "Disconnect any integration at any time",
    ],
    url: "app.visualsprint.io/settings/connections",
    footer: "connections",
    img: "/landing/vs-shot-connections.webp",
  },
];

const ANATOMY = [
  { n: "1", title: "Type + confidence.", body: "Decision, commitment, blocker or fact, with a verifier score." },
  { n: "2", title: "Citation.", body: "Speaker, timestamp and the source quote." },
  { n: "3", title: "Screen evidence.", body: "The keyframe on screen at that moment, inline." },
  { n: "4", title: "Honest gaps.", body: "Missed audio is disclosed, with the exact interval." },
];

const COMPARE_ROWS = [
  { cap: "Sinhala / Tamil code-switching", them: "Not supported anywhere", us: "Native, mid-sentence, day one" },
  { cap: "Speech ↔ screen grounding", them: "Not offered", us: "Every keyframe time-linked" },
  { cap: "Cross-meeting memory", them: "Single meeting only", us: "Org-wide, lifecycle-aware, cited" },
  { cap: "Speaker attribution", them: "Frequently muddied", us: "Exact on Zoom; honest confidence elsewhere" },
  { cap: "Capture-coverage honesty", them: "Silent gaps", us: "Gaps disclosed as first-class data" },
  { cap: "Automation", them: "Ungrounded, sometimes auto-sent", us: "Evidence-backed, human-approved" },
];

const CAPTURE_CHIPS = [
  { label: "Zoom RTMS", color: "#2d8cff" },
  { label: "Google Meet", color: "#00a15c" },
  { label: "Microsoft Teams", color: "#5b5fc7" },
];

type Tier = {
  eyebrow: string;
  price: string;
  priceSuffix?: string;
  line: string;
  features: string[];
  note?: string;
  cta: string;
  href: string;
  featured?: boolean;
  badge?: string;
};

const TIERS: Tier[] = [
  {
    eyebrow: "Free",
    price: "$0",
    line: "5 hours / month",
    features: ["Transcription"],
    cta: "Start free",
    href: "/login",
  },
  {
    eyebrow: "Individual",
    price: "$9",
    priceSuffix: "/ mo",
    line: "Personal workspace",
    features: ["Personal summaries", "Search", "Personal actions"],
    note: "No organizational memory",
    cta: "Choose Individual",
    href: "/login",
  },
  {
    eyebrow: "Organization\nBasic",
    price: "$29",
    priceSuffix: "/ user / mo",
    line: "150 pooled meeting hours",
    features: ["Organizational knowledge", "Cross-meeting progress", "Evidence-grounded reports"],
    cta: "Request an account",
    href: "/login",
    featured: true,
    badge: "Core commercial plan",
  },
  {
    eyebrow: "Business",
    price: "$59",
    priceSuffix: "/ user / mo",
    line: "Unlimited meetings*",
    features: ["Advanced intelligence", "Integrations", "Analytics & admin"],
    note: "* fair-use policy applies",
    cta: "Request an account",
    href: "/support",
  },
  {
    eyebrow: "Enterprise",
    price: "Custom",
    line: "Deployed on your terms",
    features: ["Enterprise controls", "Custom integrations", "Data residency & SSO"],
    cta: "Talk to us",
    href: "/support",
  },
];

const TRUST_BADGES = [
  "PDPA-ready handling",
  "Per-org data residency",
  "Export & erase on request",
  "Audio never silently deleted",
];

function Dot({ color }: { color: string }) {
  return <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />;
}

type LeadKind = "demo" | "collaborate";

const LEAD_COPY: Record<LeadKind, { title: string; sub: string; cta: string }> = {
  demo: {
    title: "Book a demo",
    sub: "Tell us a bit about your team and we'll get back to you to set up a walkthrough.",
    cta: "Request a demo",
  },
  collaborate: {
    title: "Collaborate with us",
    sub: "Partnerships, pilots, or just want to talk to a human -- tell us what you have in mind.",
    cta: "Send",
  },
};

function LeadModal({ kind, t, onClose }: { kind: LeadKind; t: typeof LIGHT; onClose: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const copy = LEAD_COPY[kind];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          name,
          email,
          company: company || undefined,
          message: message || undefined,
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that -- try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    fontFamily: sans,
    fontSize: 14,
    color: t.text,
    background: t.surface2,
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    padding: "10px 12px",
    outline: "none",
    boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: ".05em",
    textTransform: "uppercase",
    color: t.faint,
    marginBottom: 6,
    display: "block",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(10,11,15,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440, background: t.surface, border: `1px solid ${t.border}`, borderRadius: 16, padding: 28, boxShadow: `0 40px 80px -30px ${t.shadow}` }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 6 }}>
          <h3 style={{ fontFamily: serif, fontSize: 22, fontWeight: 600, margin: 0, color: t.text }}>{copy.title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ fontFamily: sans, fontSize: 18, lineHeight: 1, color: t.faint, background: "transparent", border: "none", cursor: "pointer", padding: 4 }}
          >
            &#10005;
          </button>
        </div>

        {done ? (
          <div style={{ padding: "20px 0 4px" }}>
            <p style={{ fontSize: 14.5, lineHeight: 1.6, color: t.text, margin: "0 0 4px" }}>
              Got it &mdash; thanks, {name.split(" ")[0] || "there"}.
            </p>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: t.muted, margin: 0 }}>We&apos;ll reach out at {email}.</p>
            <button
              type="button"
              onClick={onClose}
              style={{ marginTop: 20, fontSize: 14, fontWeight: 600, color: t.btnFg, background: t.btnBg, border: "none", borderRadius: 8, padding: "10px 18px", cursor: "pointer" }}
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13.5, lineHeight: 1.55, color: t.muted, margin: "0 0 20px" }}>{copy.sub}</p>
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={labelStyle} htmlFor="lead-name">Name</label>
                <input id="lead-name" style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div>
                <label style={labelStyle} htmlFor="lead-email">Work email</label>
                <input id="lead-email" type="email" style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div>
                <label style={labelStyle} htmlFor="lead-company">Company (optional)</label>
                <input id="lead-company" style={inputStyle} value={company} onChange={(e) => setCompany(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle} htmlFor="lead-message">
                  {kind === "demo" ? "What would you like to see? (optional)" : "What did you have in mind? (optional)"}
                </label>
                <textarea
                  id="lead-message"
                  style={{ ...inputStyle, minHeight: 80, resize: "vertical", fontFamily: sans }}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </div>
              {error && (
                <p style={{ fontSize: 12.5, color: t.gap, margin: 0 }}>{error}</p>
              )}
              <button
                type="submit"
                disabled={submitting}
                style={{
                  marginTop: 4,
                  fontSize: 14,
                  fontWeight: 600,
                  color: t.btnFg,
                  background: t.btnBg,
                  border: "none",
                  borderRadius: 8,
                  padding: "12px 18px",
                  cursor: submitting ? "default" : "pointer",
                  opacity: submitting ? 0.7 : 1,
                }}
              >
                {submitting ? "Sending…" : copy.cta}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export default function WelcomePage() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [leadKind, setLeadKind] = useState<LeadKind | null>(null);
  const t = theme === "dark" ? DARK : LIGHT;
  const wrap: React.CSSProperties = { maxWidth: 1200, margin: "0 auto", padding: "0 clamp(20px,4vw,40px)" };

  return (
    <div style={{ background: t.bg, color: t.text, minHeight: "100vh", fontFamily: sans, WebkitFontSmoothing: "antialiased" }}>
      {/* Announcement band */}
      <div style={{ background: t.band, color: t.bandText, padding: "9px clamp(20px,4vw,40px)" }}>
        <div style={{ ...wrap, display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: "#15171b", background: t.accent, borderRadius: 4, padding: "3px 8px", whiteSpace: "nowrap" }}>
            Now in MVP testing
          </span>
          <span style={{ fontSize: 12.5, color: t.bandMuted }}>A limited number of accounts are open while we test with early teams.</span>
          <a href="#pricing" style={{ fontSize: 12.5, fontWeight: 600, color: t.bandText, borderBottom: "1px solid rgba(255,255,255,.35)", whiteSpace: "nowrap" }}>
            Request an account &#8594;
          </a>
        </div>
      </div>

      {/* Header */}
      <header style={{ position: "sticky", top: 0, zIndex: 40, background: t.bg, borderBottom: `1px solid ${t.border}`, backdropFilter: "saturate(140%) blur(6px)" }}>
        <div style={{ ...wrap, padding: "14px clamp(20px,4vw,40px)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <a href="#top" style={{ fontFamily: mono, fontSize: 16, fontWeight: 600, letterSpacing: "-.01em", color: t.text, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: t.accentText }}>[</span>
            <span>VisualSprint</span>
            <span style={{ color: t.accentText }}>]</span>
          </a>
          <nav className="vs-header-nav" style={{ alignItems: "center", gap: 22, flexWrap: "wrap" }}>
            <a href="#pipeline" style={{ fontSize: 13.5, fontWeight: 500, color: t.muted }}>Pipeline</a>
            <a href="#proof" style={{ fontSize: 13.5, fontWeight: 500, color: t.muted }}>Product</a>
            <a href="#evidence" style={{ fontSize: 13.5, fontWeight: 500, color: t.muted }}>Evidence</a>
            <a href="#compare" style={{ fontSize: 13.5, fontWeight: 500, color: t.muted }}>Compare</a>
            <a href="#pricing" style={{ fontSize: 13.5, fontWeight: 500, color: t.muted }}>Pricing</a>
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              onClick={() => setTheme((s) => (s === "dark" ? "light" : "dark"))}
              title="Switch theme"
              style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: t.muted, background: "transparent", border: `1px solid ${t.border}`, borderRadius: 7, padding: "8px 11px", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
            <a href="/login" className="vs-hide-mobile" style={{ fontSize: 13.5, fontWeight: 600, color: t.text, border: `1px solid ${t.borderStrong}`, borderRadius: 8, padding: "9px 15px", whiteSpace: "nowrap" }}>
              Sign in
            </a>
            <button type="button" className="vs-hide-mobile" onClick={() => setLeadKind("collaborate")} style={{ fontFamily: sans, fontSize: 13.5, fontWeight: 600, color: t.accentText, background: t.accentSoft, border: `1px solid ${t.accent}`, borderRadius: 8, padding: "9px 15px", whiteSpace: "nowrap", cursor: "pointer" }}>
              Collaborate with us
            </button>
            <button type="button" onClick={() => setLeadKind("demo")} style={{ fontFamily: sans, fontSize: 13.5, fontWeight: 600, color: t.btnFg, background: t.btnBg, border: "none", borderRadius: 8, padding: "10px 16px", whiteSpace: "nowrap", cursor: "pointer" }}>
              Book a demo
            </button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section id="top" style={{ padding: "clamp(56px,7vw,92px) 0 clamp(48px,6vw,76px)" }}>
        <div style={wrap}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 11.5, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: t.accentText, background: t.accentSoft, borderRadius: 5, padding: "7px 11px", marginBottom: 22 }}>
            <Dot color={t.accentText} />
            Multilingual capture &middot; Sinhala, Tamil, English
          </div>
          <h1 style={{ fontFamily: serif, fontSize: "clamp(38px,4.8vw,62px)", lineHeight: 1.05, fontWeight: 600, letterSpacing: "-.025em", margin: "0 0 20px", maxWidth: 780 }}>
            Meeting decisions, backed by{" "}
            <span style={{ background: `linear-gradient(transparent 62%, ${t.accent} 62%)` }}>evidence</span>.
          </h1>
          <p style={{ fontSize: 17, lineHeight: 1.6, color: t.muted, margin: "0 0 28px", maxWidth: 600 }}>
            Capture Zoom, Meet, Teams or uploads and get organizational memory where every decision links to a speaker, a quote, and the screen that was on display at that moment.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
            <button type="button" onClick={() => setLeadKind("demo")} style={{ fontFamily: sans, fontSize: 15, fontWeight: 600, color: t.btnFg, background: t.btnBg, border: "none", borderRadius: 9, padding: "14px 24px", cursor: "pointer" }}>Book a demo</button>
            <a href="/login" style={{ fontSize: 15, fontWeight: 600, color: t.text, background: "transparent", border: `1px solid ${t.borderStrong}`, borderRadius: 9, padding: "14px 22px" }}>Sign in</a>
            <button type="button" onClick={() => setLeadKind("collaborate")} style={{ fontFamily: sans, fontSize: 15, fontWeight: 600, color: t.accentText, background: t.accentSoft, border: `1px solid ${t.accent}`, borderRadius: 9, padding: "14px 22px", cursor: "pointer" }}>Collaborate with us</button>
            <a href="#evidence" style={{ fontSize: 15, fontWeight: 600, color: t.muted, padding: "14px 8px", display: "inline-flex", alignItems: "center", gap: 8 }}>
              See how it works <span style={{ fontFamily: mono }}>&#8595;</span>
            </a>
          </div>
          <p style={{ fontFamily: mono, fontSize: 11.5, letterSpacing: ".04em", textTransform: "uppercase", color: t.faint, margin: 0 }}>
            No card required &middot; live in 10 min &middot; PDPA-ready
          </p>
        </div>
      </section>

      {/* Captures-from bar */}
      <section style={{ borderTop: `1px solid ${t.border}`, borderBottom: `1px solid ${t.border}`, background: t.surface2 }}>
        <div style={{ ...wrap, padding: "22px clamp(20px,4vw,40px)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 28, flexWrap: "wrap" }}>
          <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.faint }}>Captures from</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {CAPTURE_CHIPS.map((c) => (
              <span key={c.label} style={{ display: "inline-flex", alignItems: "center", gap: 9, background: t.surface, border: `1px solid ${t.border}`, borderRadius: 8, padding: "9px 14px", fontSize: 13.5, fontWeight: 500, color: t.text }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color, display: "inline-block" }} />
                {c.label}
              </span>
            ))}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 9, background: t.surface, border: `1px solid ${t.border}`, borderRadius: 8, padding: "9px 14px", fontSize: 13.5, fontWeight: 500, color: t.text }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: t.accentText, display: "inline-block" }} />
              Direct upload
            </span>
          </div>
        </div>
      </section>

      {/* Pipeline */}
      <section id="pipeline" style={{ background: t.band, padding: "clamp(64px,7vw,96px) 0" }}>
        <div style={wrap}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 32, flexWrap: "wrap", marginBottom: 44 }}>
            <div>
              <p style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.accent, margin: "0 0 14px" }}>The loop</p>
              <h2 style={{ fontFamily: serif, fontSize: "clamp(28px,3.4vw,42px)", lineHeight: 1.12, fontWeight: 600, letterSpacing: "-.02em", color: t.bandText, margin: 0, maxWidth: 640 }}>
                Five stages, fully auditable.
              </h2>
            </div>
            <p style={{ fontSize: 14.5, lineHeight: 1.6, color: t.bandMuted, margin: 0, maxWidth: 320 }}>No stage advances without a record of how it got there.</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 1, background: t.bandBorder, border: `1px solid ${t.bandBorder}`, borderRadius: 14, overflow: "hidden" }}>
            {PIPELINE.map((s) => (
              <div key={s.n} style={{ background: t.band, padding: "24px 22px 26px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                  <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.accent }}>{s.n}</span>
                  <span style={{ width: 26, height: 1, background: t.bandBorder, display: "block" }} />
                </div>
                <h3 style={{ fontFamily: serif, fontSize: 19, fontWeight: 600, color: t.bandText, margin: "0 0 8px" }}>{s.title}</h3>
                <p style={{ fontSize: 13.5, lineHeight: 1.55, color: t.bandMuted, margin: 0 }}>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Proof screens */}
      <section id="proof" style={{ padding: "clamp(64px,7vw,100px) 0" }}>
        <div style={wrap}>
          <p style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.accentText, margin: "0 0 14px" }}>Product</p>
          <h2 style={{ fontFamily: serif, fontSize: "clamp(28px,3.4vw,42px)", lineHeight: 1.12, fontWeight: 600, letterSpacing: "-.02em", margin: "0 0 16px", maxWidth: 700 }}>
            The screens that do the work.
          </h2>
          <p style={{ fontSize: 16, lineHeight: 1.6, color: t.muted, margin: "0 0 44px", maxWidth: 620 }}>
            The evidence-grounded report, org-memory chat, and the capture pipeline.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "clamp(40px,5vw,72px)" }}>
            {PROOF_SCREENS.map((p) => (
              <div key={p.title} className="vs-proof-grid" style={{ display: "grid", alignItems: "start" }}>
                <div className="vs-proof-sticky" style={{ position: "sticky", top: 96 }}>
                  <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: t.evidence, background: t.evidenceBg, padding: "5px 9px", borderRadius: 4 }}>
                    {p.tag}
                  </span>
                  <h3 style={{ fontFamily: serif, fontSize: 26, lineHeight: 1.2, fontWeight: 600, letterSpacing: "-.015em", margin: "16px 0 12px" }}>{p.title}</h3>
                  <p style={{ fontSize: 14.5, lineHeight: 1.65, color: t.muted, margin: "0 0 18px" }}>{p.body}</p>
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                    {p.points.map((pt, i) => (
                      <li key={pt} style={{ display: "flex", gap: 10, fontSize: 13.5, color: t.muted }}>
                        <span style={{ fontFamily: mono, color: t.accentText }}>{String(i + 1).padStart(2, "0")}</span>
                        {pt}
                      </li>
                    ))}
                  </ul>
                </div>
                <div style={{ border: `1px solid ${t.border}`, borderRadius: 16, background: t.surface, boxShadow: `0 30px 60px -34px ${t.shadow}`, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderBottom: `1px solid ${t.border}`, background: t.surface2 }}>
                    <span style={{ display: "flex", gap: 6 }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: t.borderStrong, display: "block" }} />
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: t.borderStrong, display: "block" }} />
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: t.borderStrong, display: "block" }} />
                    </span>
                    <span style={{ flex: 1, fontFamily: mono, fontSize: 11.5, color: t.faint, background: t.bg, border: `1px solid ${t.border}`, borderRadius: 6, padding: "5px 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.url}
                    </span>
                  </div>
                  <div style={{ minHeight: "clamp(240px,26vw,420px)", background: t.surface2, display: "flex", alignItems: "stretch" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.img} alt={`${p.title} screenshot`} style={{ flex: 1, width: "100%", objectFit: "contain" }} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 16px", borderTop: `1px solid ${t.border}`, background: t.surface }}>
                    <span style={{ fontFamily: mono, fontSize: 11, color: t.faint }}>product screenshot</span>
                    <span style={{ fontFamily: mono, fontSize: 11, color: t.accentText }}>{p.footer}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Evidence anatomy */}
      <section id="evidence" style={{ background: t.surface2, borderTop: `1px solid ${t.border}`, borderBottom: `1px solid ${t.border}`, padding: "clamp(64px,7vw,100px) 0" }}>
        <div style={wrap}>
          <div className="vs-evidence-grid" style={{ display: "grid", alignItems: "start" }}>
            <div>
              <p style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.accentText, margin: "0 0 14px" }}>Anatomy of a claim</p>
              <h2 style={{ fontFamily: serif, fontSize: "clamp(26px,3.2vw,38px)", lineHeight: 1.14, fontWeight: 600, letterSpacing: "-.02em", margin: "0 0 18px" }}>
                Nothing in a report is unsourced.
              </h2>
              <p style={{ fontSize: 15.5, lineHeight: 1.65, color: t.muted, margin: "0 0 28px" }}>
                Every item is written in English for the whole org, kept next to the exact quote and screen it came from &mdash; and if the capture had a gap, the report says so up front.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {ANATOMY.map((a) => (
                  <div key={a.n} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: t.btnFg, background: t.btnBg, width: 22, height: 22, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {a.n}
                    </span>
                    <p style={{ fontSize: 14, lineHeight: 1.55, color: t.muted, margin: 0 }}>
                      <strong style={{ color: t.text, fontWeight: 600 }}>{a.title}</strong> {a.body}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ background: t.gapBg, border: `1px solid ${t.gap}`, borderRadius: 12, padding: "16px 18px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                <span style={{ fontFamily: mono, fontSize: 13, color: t.gap, fontWeight: 600, flexShrink: 0 }}>&#9888;</span>
                <div>
                  <p style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", color: t.gap, margin: "0 0 6px" }}>Coverage gap &middot; 11:42&ndash;11:44</p>
                  <p style={{ fontSize: 13.5, lineHeight: 1.55, color: t.muted, margin: 0 }}>Audio not captured (mic muted). Items overlapping this interval are flagged and excluded from scoring.</p>
                </div>
              </div>

              <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: 22, boxShadow: `0 20px 40px -30px ${t.shadow}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                  <span style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.accentText, background: t.accentSoft, padding: "5px 9px", borderRadius: 4 }}>
                    Decision
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 11, fontWeight: 600, color: t.muted, border: `1px solid ${t.border}`, borderRadius: 20, padding: "4px 10px" }}>
                    confidence 0.92
                    <span style={{ display: "flex", gap: 2 }}>
                      {[1, 1, 1, 0].map((on, i) => (
                        <span key={i} style={{ width: 4, height: 9, background: on ? t.accentText : t.borderStrong, borderRadius: 1, display: "block" }} />
                      ))}
                    </span>
                  </span>
                </div>
                <p style={{ fontFamily: serif, fontSize: 20, lineHeight: 1.35, fontWeight: 600, color: t.text, margin: "0 0 18px" }}>
                  The team will migrate from MongoDB to PostgreSQL with pgvector, staged tenant by tenant over two weeks.
                </p>

                <div style={{ borderLeft: `2px solid ${t.evidence}`, background: t.evidenceBg, borderRadius: "0 8px 8px 0", padding: "12px 14px", marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: t.evidence }}>[1]</span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>Nimal Perera</span>
                    <span style={{ fontFamily: mono, fontSize: 11, color: t.muted }}>04:05</span>
                    <span style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, color: t.lang, background: t.langBg, padding: "2px 6px", borderRadius: 3 }}>SI + EN</span>
                  </div>
                  <p style={{ fontSize: 13.5, lineHeight: 1.6, color: t.text, margin: 0 }}>
                    &#8220;We should move off MongoDB and switch to PostgreSQL with pgvector.&#8221;
                  </p>
                </div>

                <div style={{ display: "flex", gap: 12, alignItems: "stretch", marginBottom: 14 }}>
                  <div style={{ width: 132, flexShrink: 0, border: `1px solid ${t.border}`, borderRadius: 8, overflow: "hidden", background: t.surface2 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/landing/vs-shot-evidence.webp" alt="On-screen keyframe: pgvector benchmark chart" style={{ width: "100%", height: 88, objectFit: "cover", display: "block" }} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 6 }}>
                    <p style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: t.evidence, margin: 0 }}>Screen evidence &middot; 04:03</p>
                    <p style={{ fontSize: 13, lineHeight: 1.5, color: t.muted, margin: 0 }}>Benchmark shared by Nimal: pgvector p95 latency vs. current cluster.</p>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderTop: `1px solid ${t.border}`, paddingTop: 14 }}>
                  <span style={{ fontFamily: mono, fontSize: 11, color: t.faint }}>reaffirmed twice &middot; superseded 0 &middot; Infra Sync, Jul 28</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" style={{ fontSize: 12.5, fontWeight: 600, color: t.text, background: "transparent", border: `1px solid ${t.borderStrong}`, borderRadius: 7, padding: "7px 13px", cursor: "pointer" }}>
                      Open in transcript
                    </button>
                    <button type="button" style={{ fontSize: 12.5, fontWeight: 600, color: t.btnFg, background: t.btnBg, border: "none", borderRadius: 7, padding: "7px 13px", cursor: "pointer" }}>
                      Trace across meetings
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: "20px 22px" }}>
                <p style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.faint, margin: "0 0 14px" }}>Queued action &middot; needs a human</p>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, flexWrap: "wrap" }}>
                  <div>
                    <p style={{ fontSize: 14.5, fontWeight: 600, color: t.text, margin: "0 0 4px" }}>Post migration recap to #infra and open JIRA INF-482</p>
                    <p style={{ fontSize: 12.5, color: t.faint, margin: 0 }}>Drafted from 3 verified items &middot; sends only on approval</p>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button type="button" style={{ fontSize: 13, fontWeight: 600, color: t.gap, background: "transparent", border: `1px solid ${t.gap}`, borderRadius: 7, padding: "9px 15px", cursor: "pointer" }}>
                      Dismiss
                    </button>
                    <button type="button" style={{ fontSize: 13, fontWeight: 600, color: t.btnFg, background: t.btnBg, border: "none", borderRadius: 7, padding: "9px 15px", cursor: "pointer" }}>
                      Approve &amp; send
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Compare */}
      <section id="compare" style={{ padding: "clamp(64px,7vw,100px) 0" }}>
        <div style={wrap}>
          <p style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.accentText, margin: "0 0 14px" }}>Where we differ</p>
          <h2 style={{ fontFamily: serif, fontSize: "clamp(26px,3.2vw,38px)", lineHeight: 1.14, fontWeight: 600, letterSpacing: "-.02em", margin: "0 0 12px", maxWidth: 640 }}>
            Where we differ.
          </h2>
          <p style={{ fontSize: 15.5, lineHeight: 1.6, color: t.muted, margin: "0 0 32px", maxWidth: 600 }}>
            Transcription and summaries are commodity. The rest requires an evidence model.
          </p>
          <div style={{ border: `1px solid ${t.border}`, borderRadius: 14, overflow: "hidden", background: t.surface }} className="scroll-x">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 640 }}>
              <thead>
                <tr style={{ background: t.surface2 }}>
                  <th style={{ textAlign: "left", fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.faint, padding: "13px 20px", borderBottom: `1px solid ${t.border}` }}>
                    Capability
                  </th>
                  <th style={{ textAlign: "left", fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.faint, padding: "13px 20px", borderBottom: `1px solid ${t.border}` }}>
                    Otter / Fireflies / Fathom
                  </th>
                  <th style={{ textAlign: "left", fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.accentText, padding: "13px 20px", borderBottom: `1px solid ${t.border}`, background: t.accentSoft }}>
                    VisualSprint
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((r, i) => (
                  <tr key={r.cap}>
                    <td style={{ padding: "16px 20px", borderBottom: i < COMPARE_ROWS.length - 1 ? `1px solid ${t.border}` : "none", fontWeight: 600, color: t.text }}>{r.cap}</td>
                    <td style={{ padding: "16px 20px", borderBottom: i < COMPARE_ROWS.length - 1 ? `1px solid ${t.border}` : "none", color: t.faint }}>{r.them}</td>
                    <td style={{ padding: "16px 20px", borderBottom: i < COMPARE_ROWS.length - 1 ? `1px solid ${t.border}` : "none", color: t.text, fontWeight: 600, background: t.accentSoft }}>{r.us}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" style={{ background: t.surface2, borderTop: `1px solid ${t.border}`, padding: "clamp(64px,7vw,100px) 0" }}>
        <div style={wrap}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 28, flexWrap: "wrap", marginBottom: 36 }}>
            <div>
              <p style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: t.accentText, margin: "0 0 14px" }}>Pricing</p>
              <h2 style={{ fontFamily: serif, fontSize: "clamp(26px,3.2vw,38px)", lineHeight: 1.14, fontWeight: 600, letterSpacing: "-.02em", margin: 0 }}>
                Start free. Pay when memory matters.
              </h2>
            </div>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: t.muted, margin: 0, maxWidth: 300 }}>
              Organizational memory begins at Organization Basic &mdash; the plans below it are personal only.
            </p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16, alignItems: "stretch" }}>
            {TIERS.map((tier) => (
              <div
                key={tier.eyebrow}
                style={{
                  background: t.surface,
                  border: tier.featured ? `2px solid ${t.accent}` : `1px solid ${t.border}`,
                  borderRadius: 14,
                  padding: tier.featured ? 23 : 24,
                  display: "flex",
                  flexDirection: "column",
                  position: "relative",
                  boxShadow: tier.featured ? `0 24px 48px -30px ${t.shadow}` : undefined,
                }}
              >
                {tier.badge && (
                  <span style={{ position: "absolute", top: -11, left: 23, fontFamily: mono, fontSize: 10, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: "#15171b", background: t.accent, padding: "4px 9px", borderRadius: 4 }}>
                    {tier.badge}
                  </span>
                )}
                <p style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, letterSpacing: ".09em", textTransform: "uppercase", color: tier.featured ? t.accentText : t.faint, margin: tier.badge ? "4px 0 14px" : "0 0 14px", lineHeight: 1.35, whiteSpace: "pre-line" }}>
                  {tier.eyebrow}
                </p>
                <p style={{ fontFamily: serif, fontSize: 34, fontWeight: 600, letterSpacing: "-.02em", margin: "0 0 4px", lineHeight: 1.05 }}>
                  {tier.price}
                  {tier.priceSuffix && <span style={{ fontFamily: sans, fontSize: 13, fontWeight: 400, color: t.faint }}> {tier.priceSuffix}</span>}
                </p>
                <p style={{ fontSize: 14, fontWeight: 600, color: t.text, margin: "0 0 16px", paddingBottom: 16, borderBottom: `1px solid ${t.border}` }}>{tier.line}</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 20 }}>
                  {tier.features.map((f) => (
                    <p key={f} style={{ fontSize: 13.5, lineHeight: 1.45, color: t.muted, margin: 0 }}>{f}</p>
                  ))}
                </div>
                {tier.note && (
                  <p style={{ fontFamily: mono, fontSize: 11.5, lineHeight: 1.5, color: t.faint, margin: "0 0 20px" }}>{tier.note}</p>
                )}
                <a
                  href={tier.href}
                  style={{
                    marginTop: "auto",
                    textAlign: "center",
                    fontSize: 14,
                    fontWeight: 600,
                    color: tier.featured ? t.btnFg : t.text,
                    background: tier.featured ? t.btnBg : t.surface2,
                    border: tier.featured ? "none" : `1px solid ${t.borderStrong}`,
                    borderRadius: 8,
                    padding: tier.featured ? 12 : 11,
                  }}
                >
                  {tier.cta}
                </a>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap", marginTop: 36 }}>
            {TRUST_BADGES.map((b) => (
              <span key={b} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.muted, background: t.surface, border: `1px solid ${t.border}`, borderRadius: 20, padding: "8px 14px" }}>
                <Dot color={t.accentText} />
                {b}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section style={{ background: t.band, padding: "clamp(64px,7vw,96px) 0" }}>
        <div style={{ ...wrap, textAlign: "center" }}>
          <h2 style={{ fontFamily: serif, fontSize: "clamp(28px,3.6vw,44px)", lineHeight: 1.1, fontWeight: 600, letterSpacing: "-.02em", color: t.bandText, margin: "0 auto 16px", maxWidth: 640 }}>
            Put your meetings on the record.
          </h2>
          <p style={{ fontSize: 15.5, lineHeight: 1.6, color: t.bandMuted, margin: "0 auto 30px", maxWidth: 520 }}>
            Connect a calendar and your next meeting arrives as a sourced report.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={() => setLeadKind("demo")} style={{ fontFamily: sans, fontSize: 15, fontWeight: 600, color: "#15171b", background: t.accent, border: "none", borderRadius: 9, padding: "14px 24px", cursor: "pointer" }}>Book a demo</button>
            <button type="button" onClick={() => setLeadKind("collaborate")} style={{ fontFamily: sans, fontSize: 15, fontWeight: 600, color: t.bandText, background: t.bandSurface, border: `1px solid ${t.accent}`, borderRadius: 9, padding: "14px 22px", cursor: "pointer" }}>Collaborate with us</button>
            <a href="#proof" style={{ fontSize: 15, fontWeight: 600, color: t.bandText, border: `1px solid ${t.bandBorder}`, borderRadius: 9, padding: "14px 22px" }}>View the screens</a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ background: t.bg, borderTop: `1px solid ${t.border}`, padding: "28px 0" }}>
        <div style={{ ...wrap, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
          <span style={{ fontFamily: mono, fontSize: 14, fontWeight: 600, color: t.text }}>
            <span style={{ color: t.accentText }}>[</span> VisualSprint <span style={{ color: t.accentText }}>]</span>
          </span>
          <nav style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
            <a href="#pipeline" style={{ fontSize: 12.5, color: t.faint }}>Pipeline</a>
            <a href="#proof" style={{ fontSize: 12.5, color: t.faint }}>Product</a>
            <a href="#pricing" style={{ fontSize: 12.5, color: t.faint }}>Pricing</a>
            <a href="/privacy" style={{ fontSize: 12.5, color: t.faint }}>Privacy</a>
            <a href="/terms" style={{ fontSize: 12.5, color: t.faint }}>Terms</a>
            <a href="/support" style={{ fontSize: 12.5, color: t.faint }}>Support</a>
          </nav>
          <p style={{ fontFamily: mono, fontSize: 11.5, color: t.faint, margin: 0 }}>&#169; 2026 &middot; evidence-grounded meeting intelligence</p>
        </div>
      </footer>

      {leadKind && <LeadModal kind={leadKind} t={t} onClose={() => setLeadKind(null)} />}
    </div>
  );
}
