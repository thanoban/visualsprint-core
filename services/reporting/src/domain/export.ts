import { createHash } from "node:crypto";
export type Evidence = {
  meetingId: string;
  version: number;
  title: string;
  notes: string;
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
  const body =
    format === "json"
      ? JSON.stringify({ schemaVersion: 1, ...evidence }, null, 2)
      : [
          `VisualSprint meeting export\n${evidence.title}\nMeeting: ${evidence.meetingId}\nRevision: ${evidence.version}`,
          `Notes (owner-authored, not verified transcript):\n${evidence.notes}`,
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
