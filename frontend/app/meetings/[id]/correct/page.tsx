"use client";

import { use, useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type {
  CorrectionRequest,
  CorrectionResponse,
  MeetingSpeakersOut,
  SpeakerCorrectionResponse,
  UtteranceOut,
} from "@/lib/types";

const LANG_LABELS: Record<string, string> = {
  si: "Sinhala",
  ta: "Tamil",
  en: "English",
  und: "unknown",
};

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

async function fetchUtterances(
  captureSessionId: string,
  authedFetch: AuthedFetch,
): Promise<UtteranceOut[]> {
  const res = await authedFetch(
    `/api/v1/meetings/${captureSessionId}/utterances`,
  );
  if (res.status === 404) {
    throw new Error("No capture session found with this ID.");
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as UtteranceOut[];
}

async function fetchMeetingSpeakers(
  captureSessionId: string,
  authedFetch: AuthedFetch,
): Promise<MeetingSpeakersOut> {
  const res = await authedFetch(
    `/api/v1/meetings/${captureSessionId}/speakers`,
  );
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as MeetingSpeakersOut;
}

async function saveSpeakerIdentity(
  captureSessionId: string,
  sessionSpeakerId: string,
  personId: string | null,
  authedFetch: AuthedFetch,
): Promise<SpeakerCorrectionResponse> {
  const res = await authedFetch(
    `/api/v1/meetings/${captureSessionId}/speakers/${sessionSpeakerId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: personId }),
    },
  );
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new Error(errBody?.detail ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as SpeakerCorrectionResponse;
}

function SpeakerIdentityPanel({
  captureSessionId,
  data,
  onSaved,
  authedFetch,
}: {
  captureSessionId: string;
  data: MeetingSpeakersOut;
  onSaved: (speakerId: string, result: SpeakerCorrectionResponse) => void;
  authedFetch: AuthedFetch;
}) {
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (data.speakers.length === 0) {
    return null;
  }

  async function handleChange(sessionSpeakerId: string, value: string) {
    setSavingId(sessionSpeakerId);
    setError(null);
    try {
      const result = await saveSpeakerIdentity(
        captureSessionId,
        sessionSpeakerId,
        value || null,
        authedFetch,
      );
      onSaved(sessionSpeakerId, result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save speaker identity.",
      );
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">
          Speaker identities
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          Correct a diarized speaker once; every utterance and speaker-derived
          owner for that cluster is re-attributed.
        </p>
      </div>
      {error && (
        <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="space-y-2">
        {data.speakers.map((speaker) => (
          <label
            key={speaker.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 text-sm"
          >
            <span className="text-slate-700">
              {speaker.cluster_id} · {speaker.utterance_count} utterance
              {speaker.utterance_count === 1 ? "" : "s"} ·{" "}
              {speaker.resolution_method}
              {speaker.confidence > 0
                ? ` ${(speaker.confidence * 100).toFixed(0)}%`
                : ""}
            </span>
            <select
              value={speaker.person_id ?? ""}
              onChange={(event) =>
                void handleChange(speaker.id, event.target.value)
              }
              disabled={savingId === speaker.id}
              className="min-w-56 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="">Unknown speaker</option>
              {data.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.display_name}
                  {person.email ? ` (${person.email})` : ""}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}

function UtteranceRow({
  utterance,
  onCorrected,
  authedFetch,
}: {
  utterance: UtteranceOut;
  onCorrected: (id: string, newText: string) => void;
  authedFetch: AuthedFetch;
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
      const res = await authedFetch("/api/v1/corrections", {
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
      setError(
        err instanceof Error ? err.message : "Failed to save correction.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span className="font-medium text-slate-700">{utterance.speaker}</span>
        {utterance.attribution_confidence < 1 && (
          <span>
            {Math.round(utterance.attribution_confidence * 100)}% attribution
          </span>
        )}
        <span>{formatTimestamp(utterance.start_s)}</span>
        {utterance.lang_tags.map((l) => (
          <span key={l} className="rounded bg-slate-100 px-1.5 py-0.5">
            {LANG_LABELS[l] ?? l}
          </span>
        ))}
        {utterance.repaired && (
          <span className="rounded bg-brand-50 text-brand-700 px-1.5 py-0.5">
            LLM-repaired
          </span>
        )}
        {saved && (
          <span className="rounded bg-green-50 text-green-700 px-1.5 py-0.5">
            Saved
          </span>
        )}
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
            Allow this correction to be used to improve transcription for this
            org
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

export default function CorrectTranscriptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Next.js 15+ made route params async -- see the same fix in
  // app/meetings/[id]/report/page.tsx for why `use()` is required here.
  const { id } = use(params);
  const { authedFetch } = useAuth();
  const [utterances, setUtterances] = useState<UtteranceOut[] | null>(null);
  const [speakerData, setSpeakerData] = useState<MeetingSpeakersOut | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Resets loading/error for a re-fetch when `id` changes (navigating
    // between meetings), not a redundant call on initial mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);

    Promise.all([
      fetchUtterances(id, authedFetch),
      fetchMeetingSpeakers(id, authedFetch),
    ])
      .then(([utteranceData, speakerIdentityData]) => {
        if (!cancelled) {
          setUtterances(utteranceData);
          setSpeakerData(speakerIdentityData);
        }
      })
      .catch((err) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Failed to load utterances",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, authedFetch]);

  function handleCorrected(utteranceId: string, newText: string) {
    setUtterances((prev) =>
      prev
        ? prev.map((u) =>
            u.id === utteranceId ? { ...u, text: newText, repaired: false } : u,
          )
        : prev,
    );
  }

  function handleSpeakerSaved(
    speakerId: string,
    result: SpeakerCorrectionResponse,
  ) {
    const person =
      speakerData?.people.find((row) => row.id === result.person_id) ?? null;
    setSpeakerData((prev) =>
      prev
        ? {
            ...prev,
            speakers: prev.speakers.map((speaker) =>
              speaker.id === speakerId
                ? {
                    ...speaker,
                    person_id: result.person_id,
                    display_name: result.display_name,
                    resolution_method: result.person_id
                      ? "manual"
                      : "unresolved",
                    confidence: result.person_id ? 1 : 0,
                  }
                : speaker,
            ),
          }
        : prev,
    );
    setUtterances((prev) =>
      prev
        ? prev.map((u) =>
            result.utterance_ids.includes(u.id)
              ? {
                  ...u,
                  speaker: person?.display_name ?? "Unknown speaker",
                  person_id: result.person_id,
                  attribution_confidence: result.person_id ? 1 : 0,
                }
              : u,
          )
        : prev,
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
        <h1 className="text-2xl font-semibold text-slate-900">
          Fix the transcript
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Every fix updates this meeting immediately and, with consent, helps
          improve transcription for this organization&apos;s future meetings.
        </p>
      </div>

      {speakerData && (
        <SpeakerIdentityPanel
          captureSessionId={id}
          data={speakerData}
          onSaved={handleSpeakerSaved}
          authedFetch={authedFetch}
        />
      )}

      {utterances.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          No transcript available yet for this meeting.
        </p>
      ) : (
        <ul className="space-y-3">
          {utterances.map((u) => (
            <UtteranceRow
              key={u.id}
              utterance={u}
              onCorrected={handleCorrected}
              authedFetch={authedFetch}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
