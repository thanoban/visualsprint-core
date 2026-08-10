"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type { EraseMeetingResponse, ExportedMeetingData, OrgSettingsOut } from "@/lib/types";

function RetentionSettings({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  const [settings, setSettings] = useState<OrgSettingsOut | null>(null);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    authedFetch(`/api/v1/orgs/${orgId}/settings`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<OrgSettingsOut>;
      })
      .then((s) => {
        setSettings(s);
        setInput(s.retention_days?.toString() ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load settings."));
  }, [orgId, authedFetch]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const trimmed = input.trim();
    const retentionDays = trimmed === "" ? null : Number(trimmed);
    if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays <= 0)) {
      setError("Retention days must be a positive whole number, or blank to keep forever.");
      setSaving(false);
      return;
    }
    try {
      const res = await authedFetch(`/api/v1/orgs/${orgId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: retentionDays, retention_days_set: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
      }
      const updated = (await res.json()) as OrgSettingsOut;
      setSettings(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <p className="text-sm text-slate-500">Loading retention settings…</p>;
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Raw evidence retention</h2>
        <p className="mt-1 text-sm text-slate-600">
          Automatically purges audio, transcript text, and keyframe images older than this many
          days. Verified knowledge (decisions, commitments, etc.) is never affected — only raw
          recording content. Leave blank to keep evidence forever, the platform default.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          step={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Keep forever"
          className="w-32 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />
        <span className="text-sm text-slate-500">days</span>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-green-700">Saved.</span>}
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

function MeetingDataRights({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  const [meetingId, setMeetingId] = useState("");
  const [exportData, setExportData] = useState<ExportedMeetingData | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<EraseMeetingResponse | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleExport() {
    if (!meetingId.trim()) return;
    setExporting(true);
    setExportError(null);
    setExportData(null);
    try {
      const res = await authedFetch(`/api/v1/orgs/${orgId}/meetings/${meetingId.trim()}/export`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
      }
      setExportData((await res.json()) as ExportedMeetingData);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Failed to export.");
    } finally {
      setExporting(false);
    }
  }

  function handleDownload() {
    if (!exportData) return;
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-${exportData.meeting_id}-export.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete() {
    if (!meetingId.trim()) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await authedFetch(`/api/v1/orgs/${orgId}/meetings/${meetingId.trim()}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
      }
      setDeleteResult((await res.json()) as EraseMeetingResponse);
      setExportData(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete.");
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Export or delete a meeting</h2>
        <p className="mt-1 text-sm text-slate-600">
          Enter a meeting id to export everything derived from it, or delete it permanently.
          Deletion is irreversible — export first if you want a copy.
        </p>
      </div>

      <input
        type="text"
        value={meetingId}
        onChange={(e) => {
          setMeetingId(e.target.value);
          setDeleteResult(null);
        }}
        placeholder="Meeting id"
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
      />

      {deleteResult ? (
        <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800">
          Meeting {deleteResult.meeting_id} and everything derived from it has been deleted.
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || !meetingId.trim()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Export"}
          </button>

          {!confirmingDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={!meetingId.trim()}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Delete
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-700">Permanently delete this meeting?</span>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Yes, delete permanently"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {exportError && <p className="text-xs text-red-700">{exportError}</p>}
      {deleteError && <p className="text-xs text-red-700">{deleteError}</p>}

      {exportData && (
        <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-900">{exportData.title || "Untitled meeting"}</p>
            <button
              type="button"
              onClick={handleDownload}
              className="rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700"
            >
              Download JSON
            </button>
          </div>
          <p className="text-xs text-slate-500">
            {exportData.capture_sessions.length} capture session
            {exportData.capture_sessions.length === 1 ? "" : "s"} ·{" "}
            {exportData.capture_sessions.reduce((n, s) => n + s.utterances.length, 0)} utterances
          </p>
        </div>
      )}
    </div>
  );
}

export default function DataRightsPage() {
  const { me } = useAuth();

  if (!me) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Data rights</h1>
        <p className="mt-1 text-sm text-slate-600">
          Retention policy and data-subject export/deletion requests.
        </p>
      </div>

      <RetentionSettings orgId={me.org.id} />
      <MeetingDataRights orgId={me.org.id} />
    </div>
  );
}
