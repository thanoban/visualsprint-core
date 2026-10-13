import type { Claim, Scope, SourceVersion } from "./evidence.js";

export type ReviewedCommitment = {
  id: string;
  meetingId: string;
  version: number;
  text: string;
  state: "open" | "done" | "unknown";
  dueAt: string | null;
  verifiedAt: string | null;
};
export type AgendaQuestion = {
  kind: "commitment" | "clarification";
  text: string;
  commitmentId: string;
  commitmentVersion: number;
  sourceMeetingId: string;
  statusVerifiedAt: string | null;
};
// Accepted facts are human records, not generated claims or independently
// verified external task status. Keep their source-health labels intact.
export type ReviewedRecord = {
  id: string;
  meetingId: string;
  version: number;
  kind: "decision" | "commitment";
  title: string;
  text: string;
  state: "accepted" | "superseded" | "open" | "completed" | "cancelled";
  ownerId: string | null;
  dueDate: string | null;
  statusSource: "human_review";
  updatedAt: string;
  citations: { captureId: string; segmentId: string; revision: number }[];
  evidenceStatus: "current" | "changed" | "unavailable";
  sourcePartial: boolean;
  externalStatus: "unknown";
  externalVerifiedAt: null;
};
export type PreparationDraft = {
  meetingId: string;
  meetingVersion: number;
  historyScope: Scope;
  sourceFingerprint: string;
  sourceVersions: SourceVersion[];
  findings: Claim[];
  questions: AgendaQuestion[];
  partial: boolean;
  reviewRequired: true;
  reviewedRecords?: ReviewedRecord[];
};
export function commitmentQuestions(
  commitments: ReviewedCommitment[],
  authorizedMeetings: Set<string>,
  now: Date,
): AgendaQuestion[] {
  if (commitments.length > 200) throw new Error("COMMITMENTS_TOO_LARGE");
  const questions: AgendaQuestion[] = [];
  for (const item of commitments) {
    if (!authorizedMeetings.has(item.meetingId)) throw new Error("COMMITMENT_SCOPE_MISMATCH");
    if (item.state === "done" && item.verifiedAt) continue;
    const verifiedOpen = item.state === "open" && item.verifiedAt !== null;
    const overdue = verifiedOpen && item.dueAt !== null && new Date(item.dueAt) < now;
    questions.push({
      kind: verifiedOpen ? "commitment" : "clarification",
      text: `${overdue ? "Review overdue commitment" : verifiedOpen ? "Confirm progress on" : "Verify current status of"}: ${item.text}`,
      commitmentId: item.id,
      commitmentVersion: item.version,
      sourceMeetingId: item.meetingId,
      statusVerifiedAt: item.verifiedAt,
    });
  }
  return questions;
}
