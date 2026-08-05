"use client";

import { use, useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/config";
import type { CorrectionRequest, CorrectionResponse, UtteranceOut } from "@/lib/types";

const LANG_LABELS: Record<string, string> = { si: "Sinhala", ta: "Tamil", en: "English", und: "unknown" };

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function fetchUtterances(captureSessionId: string): Promise<UtteranceOut[]> {
  const res = await fetch(`${API_BASE_URL}/api/v1/meetings/${captureSessionId}/utterances`);
  if (res.status === 404) {
    throw new Error("No capture session found with this ID.");
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as UtteranceOut[];
}

function UtteranceRow({
  utterance,
  onCorrected,
}: {
  utterance: UtteranceOut;
  onCorrected: (id: string, newText: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(utterance.text);
  const [glossaryTerm, setGlossaryTerm] = useState("");
  const [consent, setConsent] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Corrected text must not be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: CorrectionRequest = {
        utterance_id: utterance.id,
        corrected_text: trimmed,
        training_consent: consent,
        glossary_term: glossaryTerm.trim() || undefined,
      };
      const res = await fetch(`${API_BASE_URL}/api/v1/corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.detail ?? `${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as CorrectionResponse;
      onCorrected(utterance.id, data.corrected_text);
      setEditing(false);
      setGlossaryTerm("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save correction.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span className="font-medium text-slate-700">{utterance.speaker}</span>
        <span>{formatTimestamp(utterance.start_s)}</span>
        {utterance.lang_tags.map((l) => (
          <span key={l} className="rounded bg-slate-100 px-1.5 py-0.5">
            {LANG_LABELS[l] ?? l}
          </span>
        ))}
        {utterance.repaired && (
          <span className="rounded bg-brand-50 text-brand-700 px-1.5 py-0.5">LLM-repaired</span>
        )}
        {saved && <span className="rounded bg-green-50 text-green-700 px-1.5 py-0.5">Saved</span>}
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <input
            type="text"
            value={glossaryTerm}
            onChange={(e) => setGlossaryTerm(e.target.value)}
            placeholder="Optional: add a term to the org glossary (e.g. PAY-442)"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="rounded border-slate-300"
            />
            Allow this correction to be used to improve transcription for this org
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save correction"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setText(utterance.text);
                setError(null);
              }}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-xs text-red-700">{error}</p>}
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-slate-900">{text}</p>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-shrink-0 text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Fix
          </button>
        </div>
      )}
    </li>
  );
}

export default function CorrectTranscriptPage({ params }: { params: Promise<{ id: string }> }) {
  // Next.js 15+ made route params async -- see the same fix in
  // app/meetings/[id]/report/page.tsx for why `use()` is required here.
  const { id } = use(params);
  const [utterances, setUtterances] = useState<UtteranceOut[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Resets loading/error for a re-fetch when `id` changes (navigating
    // between meetings), not a redundant call on initial mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);

    fetchUtterances(id)
      .then((data) => {
        if (!cancelled) setUtterances(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load utterances");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  function handleCorrected(utteranceId: string, newText: string) {
    setUtterances((prev) =>
      prev ? prev.map((u) => (u.id === utteranceId ? { ...u, text: newText, repaired: false } : u)) : prev
    );
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading transcript…</p>;
  }

  if (error || !utterances) {
    return (
      <p className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
        {error ?? "Meeting not found."}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Fix the transcript</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every fix updates this meeting immediately and, with consent, helps improve transcription for
          this organization&apos;s future meetings.
        </p>
      </div>

      {utterances.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          No transcript available yet for this meeting.
        </p>
      ) : (
        <ul className="space-y-3">
          {utterances.map((u) => (
            <UtteranceRow key={u.id} utterance={u} onCorrected={handleCorrected} />
          ))}
        </ul>
      )}
    </div>
  );
}
