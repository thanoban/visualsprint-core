import { createHash } from "node:crypto";
export type ReviewedExportRecord = {
  id: string;
  meetingId: string;
  kind: "decision" | "commitment";
  title: string;
  text: string;
  ownerId: string | null;
  dueDate: string | null;
  state: "accepted" | "superseded" | "open" | "completed" | "cancelled";
  version: number;
  sourceMeetingVersion: number;
  citations: {
    captureId: string;
    segmentId: string;
    revision: number;
    captureVersion: number;
    coverage: "complete" | "partial" | "unknown";
  }[];
  sourcePartial: boolean;
  humanReviewed: true;
  humanCorrected: boolean;
  evidenceStatus: "current" | "changed" | "unavailable";
  statusSource: "human_review";
  createdAt: string;
  updatedAt: string;
};
export type ReviewedAgenda = {
  id: string;
  meetingId: string;
  title: string;
  body: string;
  version: number;
  reviewed: true;
  createdAt: string;
  updatedAt: string;
};
export type ReviewedContext = {
  schemaVersion: 1;
  complete: true;
  meetingId: string;
  meetingVersion: number;
  decisions: ReviewedExportRecord[];
  commitments: ReviewedExportRecord[];
  agendas: ReviewedAgenda[];
};
export type Evidence = {
  meetingId: string;
  version: number;
  title: string;
  notes: string;
  reviewed: ReviewedContext;
  captures: {
    id: string;
    version: number;
    state: string;
    coverage: string;
    segments: {
      id: string;
      revision: number;
      startMs: number;
      endMs: number;
      text: string;
      speakerLabel: string | null;
    }[];
  }[];
};
export function evidenceFingerprint(evidence: Evidence) {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}
export function render(evidence: Evidence, format: "text" | "json") {
  if (
    !evidence.reviewed ||
    evidence.reviewed.complete !== true ||
    evidence.reviewed.meetingId !== evidence.meetingId ||
    evidence.reviewed.meetingVersion !== evidence.version
  )
    throw new Error("EXPORT_SOURCE_CHANGED");
  const body =
    format === "json"
      ? JSON.stringify(
          {
            schemaVersion: 2,
            ...evidence,
            externalTaskVerification: "not_included",
            generatedDrafts: "not_included",
          },
          null,
          2,
        )
      : [
          `VisualSprint meeting export\n${evidence.title}\nMeeting: ${evidence.meetingId}\nRevision: ${evidence.version}`,
          `Notes (owner-authored, not verified transcript):\n${evidence.notes}`,
          ...(
            [
              ["Accepted decisions", evidence.reviewed.decisions],
              ["Accepted commitments", evidence.reviewed.commitments],
            ] as const
          ).map(([label, records]) =>
            [
              `${label} (complete bounded Workspace snapshot; human-reviewed, not provider-verified task status):`,
              ...(records.length
                ? records.map((record) =>
                    [
                      `${record.kind} ${record.id} revision ${record.version}: ${record.title}`,
                      record.text,
                      `Human state=${record.state}; responsible member=${record.ownerId ?? "unknown"}; due date=${record.dueDate ?? "unknown"}; status source=${record.statusSource}. External status: unknown (not queried).`,
                      `Evidence=${record.evidenceStatus}; partial=${record.sourcePartial}; human corrected=${record.humanCorrected}; source meeting revision=${record.sourceMeetingVersion}.`,
                      ...record.citations.map(
                        (citation) =>
                          `Evidence capture ${citation.captureId} revision ${citation.captureVersion}, segment ${citation.segmentId} revision ${citation.revision}; coverage=${citation.coverage}.`,
                      ),
                      `Created=${record.createdAt}; reviewed record updated=${record.updatedAt}.`,
                    ].join("\n"),
                  )
                : ["None in this authorized meeting snapshot."]),
            ].join("\n\n"),
          ),
          [
            "Owner-reviewed agendas (not generated preparation drafts):",
            ...(evidence.reviewed.agendas.length
              ? evidence.reviewed.agendas.map(
                  (agenda) =>
                    `${agenda.title}\n${agenda.body}\nAgenda ${agenda.id} revision ${agenda.version}; created=${agenda.createdAt}; updated=${agenda.updatedAt}.`,
                )
              : ["None in this authorized meeting snapshot."]),
          ].join("\n\n"),
          ...evidence.captures.map((c) =>
            [
              `Capture ${c.id}; state=${c.state}; coverage=${c.coverage}`,
              ...c.segments.map(
                (s) =>
                  `[${s.startMs}-${s.endMs}ms] ${s.speakerLabel ?? "Unknown speaker"}: ${s.text}\nEvidence ${s.id} revision ${s.revision}`,
              ),
            ].join("\n"),
          ),
          "Capture coverage is reported as observed; absent intervals are not reconstructed.",
        ].join("\n\n");
  if (Buffer.byteLength(body, "utf8") > 2_000_000) throw new Error("EXPORT_SIZE_LIMIT");
  return body;
}
