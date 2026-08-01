"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { API_BASE_URL } from "@/lib/config";
import {
  CAPTURE_SESSION_STATE_ORDER,
  type CaptureSessionState,
  type CaptureSessionStatus,
  type UploadResponse,
} from "@/lib/types";

const POLL_INTERVAL_MS = 2000;

function stateProgress(state: CaptureSessionState): number {
  if (state === "failed") return 0;
  const idx = CAPTURE_SESSION_STATE_ORDER.indexOf(state);
  if (idx === -1) return 0;
  return Math.round(((idx + 1) / CAPTURE_SESSION_STATE_ORDER.length) * 100);
}

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);

  const [status, setStatus] = useState<CaptureSessionStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const pollHandle = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollHandle.current) clearInterval(pollHandle.current);
    };
  }, []);

  async function pollSession(sessionId: string) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/meetings/sessions/${sessionId}`);
      if (!res.ok) {
        throw new Error(`Status check failed: ${res.status} ${res.statusText}`);
      }
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

    try {
      const form = new FormData();
      form.append("file", file);
      if (title.trim()) form.append("title", title.trim());

      const res = await fetch(`${API_BASE_URL}/api/v1/meetings/upload`, {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body?.detail) detail = body.detail;
        } catch {
          // ignore — non-JSON error body
        }
        throw new Error(detail);
      }

      const data = (await res.json()) as UploadResponse;
      setUploadResult(data);
      setStatus({
        id: data.capture_session_id,
        meeting_id: data.meeting_id,
        mode: "D",
        state: data.state,
        error: null,
      });

      pollHandle.current = setInterval(() => {
        void pollSession(data.capture_session_id);
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? `Could not reach the upload API at ${API_BASE_URL}. ${err.message}`
          : "Unknown upload error."
      );
    } finally {
      setSubmitting(false);
    }
  }

  const progress = status ? stateProgress(status.state) : 0;

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Upload a meeting</h1>
        <p className="mt-1 text-sm text-slate-600">
          Submits to <code className="rounded bg-slate-100 px-1 py-0.5">POST {API_BASE_URL}/api/v1/meetings/upload</code>.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-slate-200 bg-white p-6">
        <div>
          <label htmlFor="file" className="block text-sm font-medium text-slate-700">
            Recording (audio or video)
          </label>
          <input
            id="file"
            type="file"
            accept="audio/*,video/*,.flac,.wav,.mp3,.m4a,.mp4,.webm,.ogg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
          />
        </div>

        <div>
          <label htmlFor="title" className="block text-sm font-medium text-slate-700">
            Title <span className="text-slate-400 font-normal">(optional)</span>
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Infra sync — Jul 28"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Uploading…" : "Upload"}
        </button>

        {submitError && (
          <p className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {submitError}
          </p>
        )}
      </form>

      {uploadResult && (
        <div className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
          <div>
            <h2 className="font-medium text-slate-900">Pipeline status</h2>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">Meeting ID</dt>
              <dd className="font-mono text-xs text-slate-700 break-all">{uploadResult.meeting_id}</dd>
              <dt className="text-slate-500">Capture session ID</dt>
              <dd className="font-mono text-xs text-slate-700 break-all">{uploadResult.capture_session_id}</dd>
            </dl>
          </div>

          <div>
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="font-medium text-slate-700">
                {status?.state ?? uploadResult.state}
              </span>
              <span className="text-slate-500">{progress}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  status?.state === "failed" ? "bg-red-500" : "bg-brand-500"
                }`}
                style={{ width: `${status?.state === "failed" ? 100 : progress}%` }}
              />
            </div>
            <ol className="mt-3 flex flex-wrap gap-2 text-xs">
              {CAPTURE_SESSION_STATE_ORDER.map((s) => {
                const currentIdx = status ? CAPTURE_SESSION_STATE_ORDER.indexOf(status.state) : -1;
                const idx = CAPTURE_SESSION_STATE_ORDER.indexOf(s);
                const reached = currentIdx >= idx;
                return (
                  <li
                    key={s}
                    className={`rounded-full px-2 py-1 border ${
                      reached
                        ? "border-brand-300 bg-brand-50 text-brand-700"
                        : "border-slate-200 bg-slate-50 text-slate-400"
                    }`}
                  >
                    {s}
                  </li>
                );
              })}
            </ol>
          </div>

          {status?.state === "failed" && (
            <p className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              Pipeline failed{status.error ? `: ${status.error}` : "."}
            </p>
          )}

          {status?.state === "done" && (
            <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800 flex items-center justify-between">
              <span>Pipeline complete.</span>
              <Link
                href={`/meetings/${uploadResult.meeting_id}/report`}
                className="font-medium underline hover:no-underline"
              >
                View report →
              </Link>
            </div>
          )}

          {pollError && (
            <p className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
              Lost contact with status endpoint: {pollError}. Retrying every {POLL_INTERVAL_MS / 1000}s…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
