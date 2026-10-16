import { z } from "zod";
import { id } from "@visualsprint/contracts";

export const extractionClaim = z.object({
  kind: z.enum(["discussion", "decision", "commitment"]),
  text: z.string().min(1).max(12000),
  citation: z.object({
    meetingId: id,
    captureId: id,
    segmentId: id,
    revision: z.number().int().positive(),
  }),
});
export const extractionMetadata = z.object({
  id,
  meetingId: id,
  captureId: id,
  transcriptRevision: z.number().int().positive(),
  status: z.enum(["queued", "running", "complete", "failed", "invalidated"]),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
});
export const extractionDetail = extractionMetadata.extend({
  result: z
    .object({
      claims: z.array(extractionClaim).max(10000),
      partial: z.boolean(),
      unsupported: z.boolean(),
      reviewRequired: z.literal(true),
      sourceFingerprint: z.string().min(1),
      sourceVersions: z.array(
        z.object({
          meetingId: id,
          version: z.number().int().positive(),
          captureId: id.nullable(),
          captureVersion: z.number().int().positive().nullable(),
          coverage: z.enum(["complete", "partial", "unknown"]),
        }),
      ),
    })
    .nullable(),
});
export type ExtractionClaim = z.infer<typeof extractionClaim>;
export type ExtractionDetail = z.infer<typeof extractionDetail>;
export function validateExtractionScope(value: ExtractionDetail, meetingId: string) {
  const source = value.result?.sourceVersions;
  if (
    value.meetingId !== meetingId ||
    (value.result &&
      (value.status !== "complete" ||
        source?.length !== 1 ||
        source[0]?.meetingId !== meetingId ||
        source[0]?.captureId !== value.captureId ||
        source[0]?.captureVersion !== value.transcriptRevision ||
        value.result.claims.some(
          (claim) =>
            claim.citation.meetingId !== meetingId || claim.citation.captureId !== value.captureId,
        )))
  )
    throw new Error("EXTRACTION_SCOPE_MISMATCH");
  return value;
}
