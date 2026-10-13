import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError } from "@visualsprint/platform";
import { fingerprint, validateClaims, type Snapshot } from "../domain/evidence.js";
import type { Model } from "./ports.js";
import { modelClaims } from "./schemas.js";

// A proof is metadata, not authority. A signed Ingest hop plus current Account
// consent and owning Workspace/Ingest facts are independently required.
export const captureProcessingProof = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: id,
    ownerId: id,
    meetingId: id,
    captureId: id,
    consentId: id,
    consentVersion: z.number().int().positive(),
    captureRevision: z.number().int().positive(),
    purpose: z.literal("finalized_capture_extraction"),
    policyVersion: z.literal("english-text-v1"),
  })
  .strict();
export type CaptureProcessingProof = z.infer<typeof captureProcessingProof>;
export interface CaptureProcessingAuthority {
  authorize(proof: CaptureProcessingProof): Promise<void>;
}
export interface CaptureProcessingEvidence {
  read(proof: CaptureProcessingProof): Promise<Snapshot>;
}
export interface ExtractionQueue {
  enqueue(proof: CaptureProcessingProof): Promise<{ id: string }>;
  publish(
    proof: CaptureProcessingProof,
    input: {
      sourceFingerprint: string;
      source: Snapshot;
      claims: z.infer<typeof modelClaims>["claims"];
      partial: boolean;
    },
  ): Promise<void>;
}
export class NarrowCaptureExtraction {
  constructor(
    private readonly authority: CaptureProcessingAuthority,
    private readonly evidence: CaptureProcessingEvidence,
    private readonly queue: ExtractionQueue,
    private readonly model: Model,
  ) {}
  async enqueue(body: unknown) {
    const proof = captureProcessingProof.parse(body);
    await this.authority.authorize(proof);
    return this.queue.enqueue(proof);
  }
  async execute(body: unknown) {
    const proof = captureProcessingProof.parse(body);
    await this.authority.authorize(proof);
    const snapshot = await this.evidence.read(proof);
    assertCaptureScope(proof, snapshot);
    const hash = fingerprint(snapshot);
    if (snapshot.evidence.reduce((sum, row) => sum + row.text.length, 0) > 180_000)
      throw new AppError("EVIDENCE_TOO_LARGE", 409);
    const generated = snapshot.evidence.length
      ? modelClaims.parse(
          await this.model.generate({
            purpose: "summary",
            question: null,
            evidence: snapshot.evidence,
          }),
        )
      : { claims: [], unsupported: true };
    validateClaims(generated.claims, snapshot.evidence);
    await this.authority.authorize(proof);
    const current = await this.evidence.read(proof);
    assertCaptureScope(proof, current);
    if (fingerprint(current) !== hash) throw new AppError("SOURCE_CHANGED", 409);
    await this.queue.publish(proof, {
      sourceFingerprint: hash,
      source: snapshot,
      claims: generated.claims,
      partial: snapshot.versions.some((row) => row.coverage !== "complete"),
    });
  }
}
function assertCaptureScope(proof: CaptureProcessingProof, snapshot: Snapshot) {
  if (
    snapshot.versions.length !== 1 ||
    snapshot.versions[0]!.meetingId !== proof.meetingId ||
    snapshot.versions[0]!.captureId !== proof.captureId ||
    snapshot.versions[0]!.captureVersion !== proof.captureRevision ||
    snapshot.evidence.some(
      (row) => row.meetingId !== proof.meetingId || row.captureId !== proof.captureId,
    )
  )
    throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
}
