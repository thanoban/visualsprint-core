import { randomUUID } from "node:crypto";
import type { Evidence, ReviewedContext, ReviewedExportRecord } from "../../src/domain/export.js";
export function reviewedRecord(
  meetingId: string,
  kind: "decision" | "commitment" = "commitment",
): ReviewedExportRecord {
  return {
    id: randomUUID(),
    meetingId,
    kind,
    title: kind === "decision" ? "Reviewed decision" : "Send offer",
    text: "Human confirmed statement",
    ownerId: null,
    dueDate: kind === "decision" ? null : "2026-10-20",
    state: kind === "decision" ? "accepted" : "completed",
    version: 1,
    sourceMeetingVersion: 1,
    citations: [
      {
        captureId: randomUUID(),
        segmentId: randomUUID(),
        revision: 2,
        captureVersion: 2,
        coverage: "partial",
      },
    ],
    sourcePartial: true,
    humanReviewed: true,
    humanCorrected: true,
    evidenceStatus: "changed",
    statusSource: "human_review",
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T01:00:00Z",
  };
}
export function reviewedContext(meetingId: string): ReviewedContext {
  return {
    schemaVersion: 1,
    complete: true,
    meetingId,
    meetingVersion: 1,
    decisions: [reviewedRecord(meetingId, "decision")],
    commitments: [reviewedRecord(meetingId)],
    agendas: [
      {
        id: randomUUID(),
        meetingId,
        title: "Owner-approved agenda",
        body: "Discuss the reviewed offer; clarify delivery.",
        version: 1,
        reviewed: true,
        createdAt: "2026-10-14T00:00:00Z",
        updatedAt: "2026-10-14T01:00:00Z",
      },
    ],
  };
}
export function fullEvidence(): Evidence {
  const meetingId = randomUUID();
  return {
    meetingId,
    version: 1,
    title: "Customer call",
    notes: "Human notes",
    captures: [],
    reviewed: reviewedContext(meetingId),
  };
}
