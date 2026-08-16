"use client";

// Ported from the Claude Design project "Visualsprint core development" ->
// Upload.dc.html. The mockup's "Advance pipeline" button and "Recent
// uploads" table are demo-only fabricated state -- this app has no list-
// all-uploads API to back the latter, so it's omitted (same principle as
// chat/page.tsx dropping the fake thread history) rather than shown with
// invented rows. The mockup's 6-stage stepper (Capture/Transcribe/
// Understand/Verify/Remember/Report) is real here: it's a coarser grouping
// of the actual CAPTURE_SESSION_STATE_ORDER driven by live poll data.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { API_BASE_URL } from "@/lib/config";
import { useAuth } from "@/lib/AuthProvider";
import type {
  CaptureSessionState,
  CaptureSessionStatus,
  InstantCaptureResponse,
  UploadResponse,
} from "@/lib/types";

const POLL_INTERVAL_MS = 2000;
const sans = "'IBM Plex Sans', sans-serif";
const serif = "'Source Serif 4', serif";
const mono = "'IBM Plex Mono', monospace";

const STAGE_DEFS: { label: string; states: CaptureSessionState[] }[] = [
  { label: "Capture", states: ["scheduled", "acquiring", "acquired"] },
  { label: "Transcribe", states: ["transcribing"] },
  { label: "Understand", states: ["processing_screen", "understanding"] },
  { label: "Verify", states: ["verifying"] },
  { label: "Remember", states: ["remembering", "proposing"] },
  { label: "Report", states: ["reporting", "done"] },
];

function stageIndexFor(state: CaptureSessionState | undefined): number {
  if (!state || state === "failed") return -1;
  const idx = STAGE_DEFS.findIndex((s) => s.states.includes(state));
  return idx === -1 ? 0 : idx;
}

export default function UploadPage() {
  const { me, authedFetch } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [status, setStatus] = useState<CaptureSessionStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const pollHandle = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [instantUrl, setInstantUrl] = useState("");
  const [instantSubmitting, setInstantSubmitting] = useState(false);
  const [instantError, setInstantError] = useState<string | null>(null);
  const [instantResult, setInstantResult] = useState<InstantCaptureResponse | null>(null);

  useEffect(() => {
    return () => {
      if (pollHandle.current) clearInterval(pollHandle.current);
    };
  }, []);

  async function pollSession(sessionId: string) {
    try {
      const res = await authedFetch(`/api/v1/meetings/sessions/${sessionId}`);
      if (!res.ok) throw new Error(`Status check failed: ${res.status} ${res.statusText}`);
      const data = (await res.json()) as CaptureSessionStatus;
      setStatus(data);
      setPollError(null);
      if (data.state === "done" || data.state === "failed") {
        if (pollHandle.current) {
          clearInterval(pollHandle.current);
          pollHandle.current = null;
        }
      }
    } catch (err) {
      setPollError(err instanceof Error ? err.message : "Failed to fetch session status");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setSubmitError("Choose an audio or video file first.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setUploadResult(null);
    setStatus(null);
    setPollError(null);
    if (pollHandle.current) {
      clearInterval(pollHandle.current);
      pollHandle.current = null;
    }

    if (!me) {
      setSubmitError("Still loading your account — try again in a moment.");
      setSubmitting(false);
      return;
    }

    try {
      const form = new FormData();
      form.append("file", file);
      if (title.trim()) form.append("title", title.trim());
      form.append("org_id", me.org.id);

      const res = await authedFetch(`/api/v1/meetings/upload`, { method: "POST", body: form });
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body?.detail) detail = body.detail;
        } catch {
          // non-JSON error body
        }
        throw new Error(detail);
      }

      const data = (await res.json()) as UploadResponse;
      setUploadResult(data);
      setStatus({ id: data.capture_session_id, meeting_id: data.meeting_id, mode: "D", state: data.state, error: null });
      pollHandle.current = setInterval(() => {
        void pollSession(data.capture_session_id);
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? `Could not reach the upload API at ${API_BASE_URL}. ${err.message}` : "Unknown upload error."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleInstantCapture(e: React.FormEvent) {
    e.preventDefault();
    if (!instantUrl.trim()) {
      setInstantError("Paste a Zoom, Google Meet, or Teams link first.");
      return;
    }
    if (!me) {
      setInstantError("Still loading your account — try again in a moment.");
      return;
    }
    setInstantSubmitting(true);
    setInstantError(null);
    setInstantResult(null);
    try {
      const res = await authedFetch(`/api/v1/orgs/${me.org.id}/capture/instant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: instantUrl.trim() }),
      });
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body?.detail) detail = body.detail;
        } catch {
          // non-JSON error body
        }
        throw new Error(detail);
      }
      const data = (await res.json()) as InstantCaptureResponse;
      setInstantResult(data);
      setInstantUrl("");
    } catch (err) {
      setInstantError(err instanceof Error ? err.message : "Unknown error starting capture.");
    } finally {
      setInstantSubmitting(false);
    }
  }

  const currentStageIndex = stageIndexFor(status?.state);
  const failed = status?.state === "failed";

  return (
    <div>
      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--border)" }}>
        <p style={{ fontFamily: serif, fontSize: 20, color: "var(--text)", margin: 0 }}>Upload a meeting</p>
        <p style={{ fontSize: 13, color: "var(--text-faint)", margin: "6px 0 0" }}>
          Direct upload — Mode D, best for onboarding, backfill, and demos
        </p>
      </header>

      <main style={{ padding: "28px 32px 64px", maxWidth: 840, display: "flex", flexDirection: "column", gap: 22 }}>
        <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "22px 24px" }}>
          <p style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text)", margin: 0 }}>Capture a meeting happening right now</p>
          <p style={{ fontSize: 12.5, color: "var(--text-faint)", margin: "5px 0 16px" }}>
            No calendar entry needed. Zoom meetings on a connected host account capture automatically —
            for Google Meet or Teams, paste the meeting link to join now.
          </p>
          <form onSubmit={handleInstantCapture} style={{ display: "flex", gap: 10 }}>
            <input
              type="url"
              value={instantUrl}
              onChange={(e) => setInstantUrl(e.target.value)}
              placeholder="https://meet.google.com/xxx-xxxx-xxx or a Teams/Zoom link"
              style={{ flex: 1, fontFamily: sans, fontSize: 14, color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "10px 13px" }}
            />
            <button
              type="submit"
              disabled={instantSubmitting}
              style={{
                fontFamily: sans,
                fontSize: 13.5,
                fontWeight: 600,
                color: "#fff",
                background: "var(--accent-strong)",
                padding: "10px 20px",
                borderRadius: 7,
                border: "none",
                cursor: instantSubmitting ? "default" : "pointer",
                opacity: instantSubmitting ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {instantSubmitting ? "Starting…" : "Capture now"}
            </button>
          </form>

          {instantError && (
            <p style={{ marginTop: 12, borderRadius: 6, background: "var(--gap-bg)", border: "1px solid var(--gap)", padding: "8px 12px", fontSize: 13, color: "var(--gap)" }}>
              {instantError}
            </p>
          )}
          {instantResult && (
            <p
              style={{
                marginTop: 12,
                borderRadius: 6,
                padding: "8px 12px",
                fontSize: 13,
                background: instantResult.dispatched || instantResult.platform === "zoom" ? "var(--accent-bg)" : "var(--evidence-bg)",
                color: instantResult.dispatched || instantResult.platform === "zoom" ? "var(--accent-strong)" : "var(--evidence)",
                border: `1px solid ${instantResult.dispatched || instantResult.platform === "zoom" ? "var(--accent)" : "var(--evidence)"}`,
              }}
            >
              {instantResult.note}
            </p>
          )}
        </section>

        <form onSubmit={handleSubmit}>
          <div
            style={{
              border: "2px dashed var(--border-strong)",
              borderRadius: 14,
              padding: 44,
              textAlign: "center",
              background: "var(--surface)",
            }}
          >
            <p style={{ fontFamily: mono, fontSize: 22, color: "var(--accent)", margin: "0 0 10px" }}>↑</p>
            <p style={{ fontSize: 15.5, fontWeight: 500, color: "var(--text)", margin: "0 0 6px" }}>
              {file ? file.name : "Drop an audio or video file, or choose one below"}
            </p>
            <p style={{ fontSize: 13, color: "var(--text-faint)", margin: "0 0 20px" }}>
              MP4, MOV, WAV, MP3 · up to 4 hours · Sinhala, Tamil, English, or mixed
            </p>
            <input
              ref={fileInputRef}
              id="file"
              type="file"
              accept="audio/*,video/*,.flac,.wav,.mp3,.m4a,.mp4,.webm,.ogg"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ display: "none" }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{ fontFamily: sans, fontSize: 13.5, fontWeight: 600, color: "#fff", background: "var(--accent-strong)", padding: "10px 20px", borderRadius: 7, border: "none", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              Choose file
            </button>
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "flex-end" }}>
            <label style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 7 }}>
              Title (optional)
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Infra sync — Jul 28"
                style={{ fontFamily: sans, fontSize: 14, color: "var(--text)", background: "var(--surface)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "10px 13px" }}
              />
            </label>
            <button
              type="submit"
              disabled={submitting}
              style={{
                fontFamily: sans,
                fontSize: 13.5,
                fontWeight: 600,
                color: "#fff",
                background: "var(--accent-strong)",
                padding: "11px 20px",
                borderRadius: 7,
                border: "none",
                cursor: submitting ? "default" : "pointer",
                opacity: submitting ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {submitting ? "Uploading…" : "Upload"}
            </button>
          </div>

          {submitError && (
            <p style={{ marginTop: 12, borderRadius: 6, background: "var(--gap-bg)", border: "1px solid var(--gap)", padding: "8px 12px", fontSize: 13, color: "var(--gap)" }}>
              {submitError}
            </p>
          )}
        </form>

        {uploadResult && (
          <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "24px 26px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: 0 }}>
                {title || uploadResult.meeting_id}
              </p>
              {status?.state === "done" && (
                <Link
                  href={`/meetings/${uploadResult.capture_session_id}/report`}
                  style={{ fontFamily: sans, fontSize: 12.5, fontWeight: 600, color: "var(--accent-strong)", background: "var(--accent-bg)", border: "1px solid var(--accent)", padding: "7px 13px", borderRadius: 20, whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  View report →
                </Link>
              )}
              {status?.state && status.state !== "done" && !failed && (
                <Link
                  href={`/meetings/${uploadResult.capture_session_id}/correct`}
                  style={{ fontFamily: sans, fontSize: 12.5, fontWeight: 600, color: "var(--accent-strong)", background: "var(--accent-bg)", border: "1px solid var(--accent)", padding: "7px 13px", borderRadius: 20, whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  Fix transcript →
                </Link>
              )}
            </div>
            <p style={{ fontFamily: mono, fontSize: 12.5, color: "var(--text-faint)", margin: "6px 0 0" }}>
              {status?.state ?? uploadResult.state} · session {uploadResult.capture_session_id}
            </p>

            {failed ? (
              <p style={{ marginTop: 16, borderRadius: 6, background: "var(--gap-bg)", border: "1px solid var(--gap)", padding: "8px 12px", fontSize: 13, color: "var(--gap)" }}>
                Pipeline failed{status?.error ? `: ${status.error}` : "."}
              </p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8, marginTop: 26 }}>
                {STAGE_DEFS.map((s, i) => {
                  const isDone = i < currentStageIndex;
                  const isActive = i === currentStageIndex;
                  return (
                    <div key={s.label} style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                      <div
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: "50%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: mono,
                          fontSize: 14,
                          fontWeight: 600,
                          background: isDone ? "var(--accent-strong)" : isActive ? "var(--evidence-bg)" : "var(--surface2)",
                          color: isDone ? "#fff" : isActive ? "var(--evidence)" : "var(--text-faint)",
                          border: isActive ? "2px solid var(--evidence)" : "1px solid var(--border-strong)",
                        }}
                      >
                        {isDone ? "✓" : i + 1}
                      </div>
                      <p style={{ fontSize: 13, fontWeight: isActive ? 600 : 500, color: isActive || isDone ? "var(--text)" : "var(--text-faint)", margin: "10px 0 0" }}>
                        {s.label}
                      </p>
                      <p
                        style={{
                          fontSize: 12,
                          margin: "6px 0 0",
                          fontWeight: isActive ? 600 : 400,
                          color: isDone ? "var(--accent-strong)" : isActive ? "var(--evidence)" : "var(--text-faint)",
                        }}
                      >
                        {isDone ? "Done" : isActive ? "In progress" : "Queued"}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}

            {pollError && (
              <p style={{ marginTop: 16, borderRadius: 6, background: "var(--evidence-bg)", border: "1px solid var(--evidence)", padding: "8px 12px", fontSize: 12.5, color: "var(--evidence)" }}>
                Lost contact with status endpoint: {pollError}. Retrying every {POLL_INTERVAL_MS / 1000}s…
              </p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
