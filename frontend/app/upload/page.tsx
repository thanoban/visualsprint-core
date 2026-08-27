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
  BotSessionStatusResponse,
  CaptureSessionState,
  CaptureSessionStatus,
  InstantCaptureResponse,
  OrgSettingsOut,
  UploadResponse,
} from "@/lib/types";

const POLL_INTERVAL_MS = 2000;
const sans = "'Plus Jakarta Sans', sans-serif";
const serif = "'Plus Jakarta Sans', sans-serif";
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
  const [botStatus, setBotStatus] = useState<BotSessionStatusResponse | null>(null);
  const botPollHandle = useRef<ReturnType<typeof setInterval> | null>(null);
  const [orgSettings, setOrgSettings] = useState<OrgSettingsOut | null>(null);

  useEffect(() => {
    return () => {
      if (pollHandle.current) clearInterval(pollHandle.current);
      if (botPollHandle.current) clearInterval(botPollHandle.current);
    };
  }, []);

  // Real retention setting, shown in the sidebar panel below -- not the
  // mockup's hardcoded "90 days" copy.
  useEffect(() => {
    if (!me) return;
    authedFetch(`/api/v1/orgs/${me.org.id}/settings`)
      .then((res) => (res.ok ? (res.json() as Promise<OrgSettingsOut>) : null))
      .then(setOrgSettings)
      .catch(() => setOrgSettings(null));
  }, [me, authedFetch]);

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

  async function pollBotSession(orgId: string, botSessionId: string) {
    try {
      const res = await authedFetch(
        `/api/v1/orgs/${orgId}/capture/sessions/${botSessionId}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as BotSessionStatusResponse;
      setBotStatus(data);
      const terminal = ["ended", "failed", "missed", "lobby_timeout"];
      if (terminal.includes(data.status)) {
        if (botPollHandle.current) {
          clearInterval(botPollHandle.current);
          botPollHandle.current = null;
        }
      }
    } catch {
      // transient — keep polling
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
      setBotStatus(null);
      if (botPollHandle.current) {
        clearInterval(botPollHandle.current);
        botPollHandle.current = null;
      }
      if (data.dispatched && data.bot_session_id && me) {
        const orgId = me.org.id;
        const sessionId = data.bot_session_id;
        botPollHandle.current = setInterval(() => {
          void pollBotSession(orgId, sessionId);
        }, 5000);
      }
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
        <p style={{ fontSize: 13, color: "var(--faint)", margin: "6px 0 0" }}>
          Direct upload — Mode D, best for onboarding, backfill, and demos
        </p>
      </header>

      <main style={{ padding: "28px 32px 64px", maxWidth: 1080, display: "grid", gridTemplateColumns: "minmax(300px,1.25fr) minmax(240px,1fr)", gap: 22, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <section style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "22px 24px" }}>
          <p style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text)", margin: 0 }}>Capture a meeting happening right now</p>
          <p style={{ fontSize: 12.5, color: "var(--faint)", margin: "5px 0 16px" }}>
            Zoom captures automatically on a connected host account. Google Meet uses its connected
            Workspace calendar and official recording/transcript path after the meeting; paste a Teams
            link only when your organization has enabled its guest bot.
          </p>
          <form onSubmit={handleInstantCapture} style={{ display: "flex", gap: 10 }}>
            <input
              type="url"
              value={instantUrl}
              onChange={(e) => setInstantUrl(e.target.value)}
              placeholder="https://meet.google.com/xxx-xxxx-xxx or a Teams/Zoom link"
              style={{ flex: 1, fontFamily: sans, fontSize: 14, color: "var(--text)", background: "var(--soft)", border: "1px solid var(--border-2)", borderRadius: 8, padding: "10px 13px" }}
            />
            <button
              type="submit"
              disabled={instantSubmitting}
              style={{
                fontFamily: sans,
                fontSize: 13.5,
                fontWeight: 600,
                color: "#fff",
                background: "var(--blue-strong)",
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
            <p style={{ marginTop: 12, borderRadius: 6, background: "var(--red-soft)", border: "1px solid var(--red)", padding: "8px 12px", fontSize: 13, color: "var(--red)" }}>
              {instantError}
            </p>
          )}
          {instantResult && (
            <div style={{ marginTop: 12 }}>
              <p
                style={{
                  borderRadius: 6,
                  padding: "8px 12px",
                  fontSize: 13,
                  margin: 0,
                  background: instantResult.dispatched || instantResult.platform === "zoom" ? "var(--green-soft)" : "var(--amber-soft)",
                  color: instantResult.dispatched || instantResult.platform === "zoom" ? "var(--green)" : "var(--amber)",
                  border: `1px solid ${instantResult.dispatched || instantResult.platform === "zoom" ? "var(--green)" : "var(--amber)"}`,
                }}
              >
                {instantResult.note}
              </p>
              {instantResult.admission_guidance && (
                <p style={{ margin: "8px 0 0", borderRadius: 6, background: "var(--amber-soft)", border: "1px solid var(--amber)", padding: "8px 12px", fontSize: 12.5, color: "var(--amber)" }}>
                  Before the bot joins: {instantResult.admission_guidance}
                </p>
              )}
              {botStatus && (
                <p
                  style={{
                    marginTop: 8,
                    borderRadius: 6,
                    padding: "8px 12px",
                    fontSize: 13,
                    margin: "8px 0 0",
                    background:
                      botStatus.status === "live" ? "var(--blue-soft)" :
                      botStatus.status === "ended" ? "var(--bg)" :
                      ["failed", "missed", "lobby_timeout"].includes(botStatus.status) ? "var(--red-soft)" :
                      "var(--bg)",
                    color:
                      botStatus.status === "live" ? "var(--blue-strong)" :
                      ["failed", "missed", "lobby_timeout"].includes(botStatus.status) ? "var(--red)" :
                      "var(--faint)",
                    border:
                      botStatus.status === "live" ? "1px solid var(--blue)" :
                      ["failed", "missed", "lobby_timeout"].includes(botStatus.status) ? "1px solid var(--red)" :
                      "1px solid var(--border)",
                  }}
                >
                  {botStatus.status === "scheduled" && "⏳ Waiting for worker to dispatch…"}
                  {botStatus.status === "joining" && "🤖 Bot is joining the meeting…"}
                  {botStatus.status === "in_lobby" && "🚪 Bot is in the lobby — waiting to be admitted by the organizer."}
                  {botStatus.status === "live" && "🔴 Bot is live and recording."}
                  {botStatus.status === "ended" && "✅ Meeting ended — processing recording."}
                  {botStatus.status === "failed" && `❌ Bot failed to join${botStatus.error ? `: ${botStatus.error}` : "."}`}
                  {botStatus.status === "missed" && "⚠️ Session missed — the meeting may have already ended before the bot could join."}
                  {botStatus.status === "lobby_timeout" && `⏱ Lobby timeout${botStatus.error ? `: ${botStatus.error}` : " — the organizer did not admit the bot in time."}`}
                </p>
              )}
            </div>
          )}
        </section>

        <form onSubmit={handleSubmit}>
          <div
            style={{
              border: "2px dashed var(--border-2)",
              borderRadius: 14,
              padding: 44,
              textAlign: "center",
              background: "var(--bg)",
            }}
          >
            <p style={{ fontFamily: mono, fontSize: 22, color: "var(--blue)", margin: "0 0 10px" }}>↑</p>
            <p style={{ fontSize: 15.5, fontWeight: 500, color: "var(--text)", margin: "0 0 6px" }}>
              {file ? file.name : "Drop an audio or video file, or choose one below"}
            </p>
            <p style={{ fontSize: 13, color: "var(--faint)", margin: "0 0 20px" }}>
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
              style={{ fontFamily: sans, fontSize: 13.5, fontWeight: 600, color: "#fff", background: "var(--blue-strong)", padding: "10px 20px", borderRadius: 7, border: "none", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              Choose file
            </button>
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "flex-end" }}>
            <label style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 7 }}>
              Title (optional)
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Infra sync — Jul 28"
                style={{ fontFamily: sans, fontSize: 14, color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border-2)", borderRadius: 8, padding: "10px 13px" }}
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
                background: "var(--blue-strong)",
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
            <p style={{ marginTop: 12, borderRadius: 6, background: "var(--red-soft)", border: "1px solid var(--red)", padding: "8px 12px", fontSize: 13, color: "var(--red)" }}>
              {submitError}
            </p>
          )}
        </form>

        {uploadResult && (
          <section style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "24px 26px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: 0 }}>
                {title || uploadResult.meeting_id}
              </p>
              {status?.state === "done" && (
                <Link
                  href={`/meetings/${uploadResult.capture_session_id}/report`}
                  style={{ fontFamily: sans, fontSize: 12.5, fontWeight: 600, color: "var(--green)", background: "var(--green-soft)", border: "1px solid var(--green)", padding: "7px 13px", borderRadius: 20, whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  View report →
                </Link>
              )}
              {status?.state && status.state !== "done" && !failed && (
                <Link
                  href={`/meetings/${uploadResult.capture_session_id}/correct`}
                  style={{ fontFamily: sans, fontSize: 12.5, fontWeight: 600, color: "var(--blue-strong)", background: "var(--blue-soft)", border: "1px solid var(--blue)", padding: "7px 13px", borderRadius: 20, whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  Fix transcript →
                </Link>
              )}
            </div>
            <p style={{ fontFamily: mono, fontSize: 12.5, color: "var(--faint)", margin: "6px 0 0" }}>
              {status?.state ?? uploadResult.state} · session {uploadResult.capture_session_id}
            </p>

            {failed ? (
              <p style={{ marginTop: 16, borderRadius: 6, background: "var(--red-soft)", border: "1px solid var(--red)", padding: "8px 12px", fontSize: 13, color: "var(--red)" }}>
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
                          background: isDone ? "var(--green)" : isActive ? "var(--amber-soft)" : "var(--soft)",
                          color: isDone ? "#fff" : isActive ? "var(--amber)" : "var(--faint)",
                          border: isActive ? "2px solid var(--amber)" : "1px solid var(--border-2)",
                        }}
                      >
                        {isDone ? "✓" : i + 1}
                      </div>
                      <p style={{ fontSize: 13, fontWeight: isActive ? 600 : 500, color: isActive || isDone ? "var(--text)" : "var(--faint)", margin: "10px 0 0" }}>
                        {s.label}
                      </p>
                      <p
                        style={{
                          fontSize: 12,
                          margin: "6px 0 0",
                          fontWeight: isActive ? 600 : 400,
                          color: isDone ? "var(--green)" : isActive ? "var(--amber)" : "var(--faint)",
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
              <p style={{ marginTop: 16, borderRadius: 6, background: "var(--amber-soft)", border: "1px solid var(--amber)", padding: "8px 12px", fontSize: 12.5, color: "var(--amber)" }}>
                Lost contact with status endpoint: {pollError}. Retrying every {POLL_INTERVAL_MS / 1000}s…
              </p>
            )}
          </section>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <section style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 16, padding: "18px 20px" }}>
          <p style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--faint)", margin: "0 0 12px" }}>
            Retention
          </p>
          <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--muted)", margin: "0 0 4px" }}>
            {orgSettings?.retention_days
              ? `Derived artifacts (transcripts, keyframes) are kept ${orgSettings.retention_days} days, then deleted, per this org's retention policy.`
              : "This org has no retention limit configured -- derived artifacts (transcripts, keyframes) are kept indefinitely."}
          </p>
          <p style={{ fontSize: 12, lineHeight: 1.5, color: "var(--faint)", margin: 0 }}>
            Raw audio and video are deleted automatically once the pipeline finishes processing them --
            not opt-in, and not affected by this setting.
          </p>
        </section>
      </div>
      </main>
    </div>
  );
}
