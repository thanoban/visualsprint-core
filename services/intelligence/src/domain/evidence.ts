import { createHash } from "node:crypto";

export type Scope = { kind: "meeting" | "project" | "customer" | "workspace"; id: string | null };
export type Evidence = {
  meetingId: string;
  captureId: string;
  segmentId: string;
  revision: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string | null;
};
export type SourceVersion = {
  meetingId: string;
  version: number;
  captureId: string | null;
  captureVersion: number | null;
  coverage: "complete" | "partial" | "unknown";
};
export type Snapshot = { versions: SourceVersion[]; evidence: Evidence[] };
export type Claim = {
  kind: "discussion" | "decision" | "commitment";
  text: string;
  citation: Omit<Evidence, "text" | "speakerLabel" | "startMs" | "endMs">;
};
export type Result = {
  claims: Claim[];
  partial: boolean;
  unsupported: boolean;
  sourceFingerprint: string;
  sourceVersions: SourceVersion[];
  reviewRequired: true;
};
export function fingerprint(snapshot: Snapshot): string {
  // Include content, correction revisions and the exact authorized source set.
  const versions = [...snapshot.versions].sort((a, b) => a.meetingId.localeCompare(b.meetingId));
  const evidence = [...snapshot.evidence].sort((a, b) =>
    `${a.meetingId}:${a.captureId}:${a.segmentId}`.localeCompare(
      `${b.meetingId}:${b.captureId}:${b.segmentId}`,
    ),
  );
  return createHash("sha256").update(JSON.stringify({ versions, evidence })).digest("hex");
}
export function validateClaims(claims: Claim[], provided: Evidence[]): void {
  const sources = new Map(
    provided.map((row) => [
      `${row.meetingId}:${row.captureId}:${row.segmentId}:${row.revision}`,
      row,
    ]),
  );
  for (const claim of claims) {
    const ref = claim.citation;
    const row = sources.get(`${ref.meetingId}:${ref.captureId}:${ref.segmentId}:${ref.revision}`);
    // Initial verified mode is intentionally extractive. A real segment citation
    // does not by itself prove an arbitrary generated paraphrase or owner/date.
    if (!row || !claim.text.trim() || !row.text.includes(claim.text))
      throw new Error("UNSUPPORTED_CLAIM");
  }
}
export function selectEvidence(snapshot: Snapshot, question: string | null): Evidence[] {
  if (question === null) {
    if (snapshot.evidence.reduce((sum, row) => sum + row.text.length, 0) > 180_000)
      throw new Error("EVIDENCE_TOO_LARGE");
    return snapshot.evidence;
  }
  const words = new Set(question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const ranked = snapshot.evidence
    .map((row, index) => ({
      row,
      index,
      score: [...words].reduce(
        (score, word) => score + (row.text.toLowerCase().includes(word) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: Evidence[] = [];
  let characters = 0;
  for (const { row } of ranked) {
    if (selected.length >= 100 || characters + row.text.length > 60_000) continue;
    selected.push(row);
    characters += row.text.length;
  }
  return selected;
}
