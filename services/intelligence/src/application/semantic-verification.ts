import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError } from "@visualsprint/platform";
import type { Evidence } from "../domain/evidence.js";

export const semanticClaim = z
  .object({
    id,
    kind: z.enum(["discussion", "decision", "commitment"]),
    text: z.string().trim().min(1).max(4000),
    citation: z
      .object({
        meetingId: id,
        captureId: id,
        segmentId: id,
        revision: z.number().int().nonnegative(),
        quote: z.string().min(1).max(4000),
      })
      .strict(),
  })
  .strict();
export type SemanticClaim = z.infer<typeof semanticClaim>;
export type IndependentVerificationInput = { claim: SemanticClaim; evidence: Evidence };
export const verificationVerdicts = z
  .object({
    verdicts: z
      .array(
        z
          .object({ claimId: id, verdict: z.enum(["supported", "unsupported", "uncertain"]) })
          .strict(),
      )
      .max(50),
  })
  .strict();
export interface IndependentVerifier {
  verify(input: IndependentVerificationInput[]): Promise<unknown>;
}
export async function verifySemanticClaims(
  body: unknown,
  evidence: Evidence[],
  verifier: IndependentVerifier,
): Promise<SemanticClaim[]> {
  const claims = z.array(semanticClaim).max(50).parse(body);
  if (new Set(claims.map((row) => row.id)).size !== claims.length)
    throw new AppError("DUPLICATE_CLAIM", 422);
  const source = new Map(
    evidence.map((row) => [
      `${row.meetingId}:${row.captureId}:${row.segmentId}:${row.revision}`,
      row,
    ]),
  );
  const input: IndependentVerificationInput[] = claims.map((claim) => {
    const citation = claim.citation;
    const row = source.get(
      `${citation.meetingId}:${citation.captureId}:${citation.segmentId}:${citation.revision}`,
    );
    if (!row || !row.text.includes(citation.quote))
      throw new AppError("CITATION_NOT_SUPPORTED", 422);
    // Exact schema objects only: extractor reasoning is neither accepted nor
    // forwarded. Verification sees the proposed claim plus its raw evidence.
    return { claim, evidence: row };
  });
  if (!input.length) return [];
  if (
    input.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row), "utf8"), 0) >
    180_000
  )
    throw new AppError("VERIFICATION_EVIDENCE_TOO_LARGE", 409);
  const checked = verificationVerdicts.parse(await verifier.verify(input));
  const verdicts = new Map(checked.verdicts.map((row) => [row.claimId, row.verdict]));
  if (
    verdicts.size !== checked.verdicts.length ||
    verdicts.size !== claims.length ||
    claims.some((row) => !verdicts.has(row.id))
  )
    throw new AppError("INVALID_VERIFICATION_RESULT", 502);
  if (claims.some((row) => verdicts.get(row.id) !== "supported"))
    throw new AppError("CLAIM_NOT_VERIFIED", 422);
  return claims;
}
