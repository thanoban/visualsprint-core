"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { getSupabaseClient } from "@/lib/supabaseClient";

// Ported from the Claude Design project "Visualsprint core development" ->
// Login.dc.html, translating its template-string styles into inline style
// objects (same convention as lib/AppSidebar.tsx). The mockup hardcodes its
// own LIGHT token set rather than reading the app's --bg/--text/etc. custom
// properties -- this page keeps that choice deliberately: an auth screen
// shouldn't flip with the rest of the app's dark-mode toggle, and the design
// itself never offers one here.
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
  accentStrong: "#145c44",
  gap: "#ab4a2f",
  gapBg: "#f6e6df",
};

const sans = "'Plus Jakarta Sans', sans-serif";
const mono = "'IBM Plex Mono', monospace";

type Mode = "signin" | "signup";

function GoogleGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.6H24v9h11.9c-.5 2.8-2.1 5.2-4.5 6.8v5.6h7.3c4.3-4 6.4-9.8 6.4-16.8z" />
      <path fill="#34A853" d="M24 46c6.1 0 11.3-2 15.1-5.5l-7.3-5.6c-2 1.4-4.7 2.2-7.8 2.2-6 0-11-4-12.8-9.5H3.6v5.8C7.3 40.9 15 46 24 46z" />
      <path fill="#FBBC05" d="M11.2 27.6c-.5-1.4-.7-2.9-.7-4.6s.3-3.2.7-4.6v-5.8H3.6C2 15.8 1 19.5 1 23c0 3.5 1 7.2 2.6 10.4z" />
      <path fill="#EA4335" d="M24 10.8c3.3 0 6.3 1.1 8.6 3.3l6.5-6.5C35.3 4 30.1 2 24 2 15 2 7.3 7.1 3.6 14.6l7.6 5.8c1.8-5.5 6.8-9.6 12.8-9.6z" />
    </svg>
  );
}

function MicrosoftGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 23 23" style={{ flexShrink: 0 }}>
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
      <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
    </svg>
  );
}

function ssoButtonStyle(): React.CSSProperties {
  return {
    fontFamily: sans,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    fontSize: 14,
    fontWeight: 500,
    color: LIGHT.text,
    background: LIGHT.surface,
    border: `1px solid ${LIGHT.borderStrong}`,
    padding: "11px 16px",
    borderRadius: 8,
    cursor: "pointer",
  };
}

export default function LoginPage() {
  const { configError } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const isSignUp = mode === "signup";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");
    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }
    setSubmitting(true);
    try {
      const supabase = getSupabaseClient();
      if (isSignUp) {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: name || undefined } },
        });
        if (signUpError) throw signUpError;
        setInfo("Check your email to confirm your account, then sign in.");
        setMode("signin");
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        router.replace("/");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOAuth(provider: "google" | "azure") {
    setError("");
    try {
      const { error: oauthError } = await getSupabaseClient().auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/` },
      });
      if (oauthError) setError(oauthError.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (configError) {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", fontFamily: sans }}>
        <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 24, fontWeight: 600, color: LIGHT.text }}>
          Sign-in isn&apos;t set up yet
        </h1>
        <p
          style={{
            marginTop: 12,
            borderRadius: 6,
            background: "#fef3c7",
            border: "1px solid #fde68a",
            padding: "8px 12px",
            fontSize: 14,
            color: "#92400e",
          }}
        >
          {configError}
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        background: LIGHT.bg,
        color: LIGHT.text,
        fontFamily: sans,
        minHeight: "100vh",
        display: "grid",
        gridTemplateColumns: "minmax(0,560px) 1fr",
      }}
    >
      <div
        style={{
          padding: "40px 64px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          minHeight: "100vh",
        }}
      >
        <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none" }}>
          <span style={{ fontFamily: mono, color: LIGHT.accent, fontWeight: 600 }}>[</span>
          <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 16, fontWeight: 600, color: LIGHT.text }}>
            VisualSprint
          </span>
          <span style={{ fontFamily: mono, color: LIGHT.accent, fontWeight: 600 }}>]</span>
        </Link>

        <div style={{ maxWidth: 380, width: "100%", margin: "0 auto" }}>
          <div
            style={{
              display: "flex",
              gap: 4,
              background: LIGHT.surface2,
              borderRadius: 9,
              padding: 4,
              marginBottom: 36,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setMode("signin");
                setError("");
              }}
              style={{
                flex: 1,
                fontFamily: sans,
                fontSize: 13.5,
                fontWeight: !isSignUp ? 600 : 500,
                color: !isSignUp ? LIGHT.text : LIGHT.textFaint,
                background: !isSignUp ? LIGHT.surface : "transparent",
                padding: 9,
                borderRadius: 7,
                border: "none",
                cursor: "pointer",
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("signup");
                setError("");
              }}
              style={{
                flex: 1,
                fontFamily: sans,
                fontSize: 13.5,
                fontWeight: isSignUp ? 600 : 500,
                color: isSignUp ? LIGHT.text : LIGHT.textFaint,
                background: isSignUp ? LIGHT.surface : "transparent",
                padding: 9,
                borderRadius: 7,
                border: "none",
                cursor: "pointer",
              }}
            >
              Create account
            </button>
          </div>

          <h1
            style={{
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontSize: 29,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: LIGHT.text,
              margin: "0 0 8px",
            }}
          >
            {isSignUp ? "Create your workspace" : "Welcome back"}
          </h1>
          <p style={{ fontSize: 14.5, color: LIGHT.textMuted, margin: "0 0 30px", lineHeight: 1.55 }}>
            {isSignUp
              ? "Set up VisualSprint for yourself or your team in under two minutes."
              : "Sign in to pick up your org memory where you left off."}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
            <button type="button" onClick={() => handleOAuth("google")} style={ssoButtonStyle()}>
              <GoogleGlyph />
              Continue with Google
            </button>
            <button type="button" onClick={() => handleOAuth("azure")} style={ssoButtonStyle()}>
              <MicrosoftGlyph />
              Continue with Microsoft
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
            <span style={{ flex: 1, height: 1, background: LIGHT.border }} />
            <span style={{ fontSize: 12, color: LIGHT.textFaint, whiteSpace: "nowrap" }}>or with email</span>
            <span style={{ flex: 1, height: 1, background: LIGHT.border }} />
          </div>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {isSignUp && (
              <label
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: LIGHT.textMuted,
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                }}
              >
                Full name
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nimal Perera"
                  style={inputStyle()}
                />
              </label>
            )}

            <label
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: LIGHT.textMuted,
                display: "flex",
                flexDirection: "column",
                gap: 7,
              }}
            >
              Work email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                style={inputStyle()}
              />
            </label>

            <label
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: LIGHT.textMuted,
                display: "flex",
                flexDirection: "column",
                gap: 7,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span>Password</span>
                {!isSignUp && (
                  <a href="#" style={{ fontSize: 12, fontWeight: 500, color: LIGHT.textFaint }}>
                    Forgot password?
                  </a>
                )}
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isSignUp ? "At least 8 characters" : "••••••••"}
                required
                minLength={isSignUp ? 8 : undefined}
                style={inputStyle()}
              />
            </label>

            {error && (
              <p
                style={{
                  fontSize: 12.5,
                  color: LIGHT.gap,
                  background: LIGHT.gapBg,
                  border: `1px solid ${LIGHT.gap}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                  margin: 0,
                }}
              >
                {error}
              </p>
            )}
            {info && (
              <p
                style={{
                  fontSize: 12.5,
                  color: LIGHT.accentStrong,
                  background: "#e3f1ea",
                  border: `1px solid ${LIGHT.accent}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                  margin: 0,
                }}
              >
                {info}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              style={{
                fontFamily: sans,
                fontSize: 14.5,
                fontWeight: 600,
                color: "#fff",
                background: LIGHT.accentStrong,
                border: "none",
                padding: 13,
                borderRadius: 8,
                cursor: submitting ? "default" : "pointer",
                marginTop: 6,
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? "Please wait…" : isSignUp ? "Create account" : "Sign in"}
            </button>
          </form>

          <p style={{ fontSize: 13.5, color: LIGHT.textFaint, textAlign: "center", margin: "26px 0 0" }}>
            {isSignUp ? "Already have an account?" : "New to VisualSprint?"}{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setMode(isSignUp ? "signin" : "signup");
                setError("");
              }}
              style={{ fontSize: 13, fontWeight: 600, color: LIGHT.accentStrong }}
            >
              {isSignUp ? "Sign in" : "Create one"}
            </a>
          </p>
        </div>

        <p style={{ fontSize: 11.5, color: LIGHT.textFaint, lineHeight: 1.6, maxWidth: 400, margin: "0 auto" }}>
          By continuing you agree to our{" "}
          <a href="/terms" style={{ color: LIGHT.textFaint, textDecoration: "underline" }}>
            Terms
          </a>{" "}
          and{" "}
          <a href="/privacy" style={{ color: LIGHT.textFaint, textDecoration: "underline" }}>
            Privacy Policy
          </a>
          . VisualSprint stores meeting audio and transcripts under per-org data residency — see{" "}
          <a href="/data-rights" style={{ color: LIGHT.textFaint, textDecoration: "underline" }}>
            data rights
          </a>
          .
        </p>
      </div>

      <div
        style={{
          background: "#12161c",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 56,
          gap: 32,
        }}
      >
        <h2
          style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: 25,
            lineHeight: 1.35,
            color: "#f2efe6",
            textAlign: "center",
            maxWidth: 440,
            margin: 0,
          }}
        >
          Meetings end. The reasoning behind them shouldn&apos;t disappear with them.
        </h2>

        <div style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", maxWidth: 520 }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <span
              style={{
                fontFamily: mono,
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: "0.03em",
                textTransform: "uppercase",
                color: "#8a7360",
              }}
            >
              Without VisualSprint
            </span>
            <div style={{ background: "#1a1f27", border: "1px solid #3a2f2a", borderRadius: 10, padding: 16, height: "100%" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
                <span style={{ height: 6, width: "86%", background: "#3a3530", borderRadius: 3, display: "block" }} />
                <span style={{ height: 6, width: "54%", background: "#3a3530", borderRadius: 3, display: "block" }} />
                <span style={{ height: 6, width: "70%", background: "#3a3530", borderRadius: 3, display: "block" }} />
              </div>
              <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "#8a8378", margin: 0 }}>
                A decision gets made out loud, in a meeting no one reopens. Weeks later, nobody can say why.
              </p>
            </div>
          </div>

          <span style={{ fontSize: 18, color: "#4a5260", flexShrink: 0 }}>→</span>

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <span
              style={{
                fontFamily: mono,
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: "0.03em",
                textTransform: "uppercase",
                color: "#5cd1ab",
              }}
            >
              With VisualSprint
            </span>
            <div style={{ background: "#1a1f27", border: "1px solid #2a3a34", borderRadius: 10, padding: 16, height: "100%" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.03em",
                    textTransform: "uppercase",
                    color: "#8a95a5",
                    border: "1px solid #3a4250",
                    padding: "2px 7px",
                    borderRadius: 4,
                  }}
                >
                  Decision
                </span>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#5cd1ab",
                    background: "rgba(58,184,146,0.14)",
                    padding: "3px 8px",
                    borderRadius: 20,
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#3ab892", display: "inline-block" }} />
                  Verified
                </span>
              </div>
              <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "#a8a290", margin: 0 }}>
                Traced to a speaker, a timestamp, and the exact words used — searchable from any future chat.
              </p>
            </div>
          </div>
        </div>

        <p style={{ fontSize: 13.5, color: "#726c5c", maxWidth: 400, textAlign: "center", lineHeight: 1.6, margin: 0 }}>
          Works the same whether your team speaks English, or switches between Sinhala, Tamil, and English
          mid-sentence.
        </p>
      </div>
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    fontFamily: sans,
    fontSize: 14.5,
    color: LIGHT.text,
    background: LIGHT.surface,
    border: `1px solid ${LIGHT.borderStrong}`,
    borderRadius: 8,
    padding: "11px 13px",
    fontWeight: 400,
  };
}
