import { z } from "zod";
import { createHash } from "node:crypto";
import { eventEnvelope, id, type DomainEvent } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import { fingerprint, validateClaims, type Snapshot, type Result } from "../domain/evidence.js";
import type { Model, Sources } from "./ports.js";
import { modelClaims } from "./schemas.js";
import { modelOperationId } from "./model-usage.js";
import {
  ExtractionLimitError,
  extractionChunks,
  extractionInput,
  extractionInputBound,
  mergeExtractionClaims,
} from "../domain/extraction-chunks.js";
export type ExtractionChunkOutput = z.infer<typeof modelClaims>;

export const finalizedCaptureProof = z
  .object({
    workspaceId: id,
    ownerId: id,
    meetingId: id,
    captureId: id,
    consentId: id,
    consentVersion: z.number().int().positive(),
    transcriptRevision: z.number().int().positive(),
    policyVersion: z.literal("english-text-v1"),
  })
  .strict();
export type FinalizedCaptureProof = z.infer<typeof finalizedCaptureProof>;
export type CaptureExtractionJob = {
  id: string;
  proof: FinalizedCaptureProof;
  status: "queued" | "running" | "complete" | "failed" | "invalidated";
  attempts: number;
  completedChunks?: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
  result: Result | null;
  errorCode: string | null;
  createdAt: Date;
};
export interface CaptureExtractionEvidence {
  authorize(proof: FinalizedCaptureProof): Promise<void>;
  read(proof: FinalizedCaptureProof): Promise<Snapshot>;
  owner(actor: Actor, meetingId: string): Promise<void>;
}
export interface CaptureExtractionJobs {
  accept(
    event: DomainEvent,
    proof: FinalizedCaptureProof,
  ): Promise<{ id: string | null; rejected?: true }>;
  reject(event: DomainEvent, proof: FinalizedCaptureProof, code: string): Promise<void>;
  claim(workspaceId: string, id: string): Promise<CaptureExtractionJob | null>;
  guard(job: CaptureExtractionJob): Promise<void>;
  chunks(job: CaptureExtractionJob, plan: string, count: number): Promise<ExtractionChunkOutput[]>;
  checkpoint(
    job: CaptureExtractionJob,
    plan: string,
    index: number,
    output: ExtractionChunkOutput,
  ): Promise<void>;
  yield(job: CaptureExtractionJob): Promise<void>;
  complete(job: CaptureExtractionJob, result: Result): Promise<void>;
  fail(job: CaptureExtractionJob, code: string, retry: boolean): Promise<void>;
  due(): Promise<{ workspaceId: string; id: string }[]>;
  load(actor: Actor, id: string): Promise<CaptureExtractionJob | null>;
  list(actor: Actor, meetingId: string): Promise<CaptureExtractionJob[]>;
  invalidate(job: CaptureExtractionJob): Promise<void>;
  purgeMeeting(workspaceId: string, meetingId: string): Promise<void>;
}
export interface CaptureExtractionAdmission {
  reserve(
    proof: FinalizedCaptureProof,
    input: { operationId: string; maxInputTokens: number; maxOutputTokens: number },
  ): Promise<{
    reservationId: string;
    replay: boolean;
    state: "held" | "succeeded" | "unknown" | "not_started";
  }>;
  record(
    proof: FinalizedCaptureProof,
    operationId: string,
    reservationId: string,
    outcome: "succeeded" | "unknown" | "not_started",
  ): Promise<void>;
}
export const processingActor = (proof: FinalizedCaptureProof): Actor => ({
  workspaceId: proof.workspaceId,
  actorId: proof.ownerId,
  operationGrantId: proof.consentId,
  sessionId: `operation:${proof.consentId}`,
});
export const processingBinding = (proof: FinalizedCaptureProof) => ({
  consentId: proof.consentId,
  expectedVersion: proof.consentVersion,
  meetingId: proof.meetingId,
  captureId: proof.captureId,
  policyVersion: proof.policyVersion,
});
export function proofFromCaptureEvent(body: unknown) {
  const event = eventEnvelope.parse(body);
  if (event.type !== "capture.processing.ready.v1" || !event.actorId)
    throw new AppError("INVALID_PROCESSING_EVENT", 400);
  const meeting = event.references.find((ref) => ref.kind === "meeting"),
    capture = event.references.find((ref) => ref.kind === "capture"),
    consent = event.references.find((ref) => ref.kind === "processing_consent");
  if (!meeting || !capture || !consent) throw new AppError("INVALID_PROCESSING_EVENT", 400);
  return {
    event,
    proof: finalizedCaptureProof.parse({
      workspaceId: event.workspaceId,
      ownerId: event.actorId,
      meetingId: meeting.id,
      captureId: capture.id,
      consentId: consent.id,
      consentVersion: consent.revision,
      transcriptRevision: event.aggregateVersion,
      policyVersion: "english-text-v1",
    }),
  };
}
function exactScope(proof: FinalizedCaptureProof, snapshot: Snapshot) {
  const version = snapshot.versions[0];
  if (
    snapshot.versions.length !== 1 ||
    !version ||
    version.meetingId !== proof.meetingId ||
    version.captureId !== proof.captureId ||
    version.captureVersion !== proof.transcriptRevision ||
    snapshot.evidence.some(
      (row) => row.meetingId !== proof.meetingId || row.captureId !== proof.captureId,
    )
  )
    throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
}
export class DurableCaptureExtraction {
  constructor(
    private readonly jobs: CaptureExtractionJobs,
    private readonly evidence: CaptureExtractionEvidence,
    private readonly model: Model,
    private readonly admission: CaptureExtractionAdmission,
    private readonly normalSources: Sources,
  ) {}
  async consume(body: unknown) {
    const { event, proof } = proofFromCaptureEvent(body);
    try {
      await this.evidence.authorize(proof);
    } catch (error) {
      if (error instanceof AppError && (error.status === 403 || error.code === "SOURCE_DELETED")) {
        await this.jobs.reject(event, proof, error.code);
        return { id: null, rejected: true as const };
      }
      throw error;
    }
    return this.jobs.accept(event, proof);
  }
  async work(workspaceId: string, id: string) {
    const job = await this.jobs.claim(workspaceId, id);
    if (!job) return;
    let completedChunks = job.completedChunks ?? 0;
    try {
      await this.evidence.authorize(job.proof);
      const snapshot = await this.evidence.read(job.proof);
      exactScope(job.proof, snapshot);
      const hash = fingerprint(snapshot),
        chunks = extractionChunks(snapshot.evidence);
      // Chunk boundaries are part of the durable plan. A deployment must not
      // reinterpret already-spent operation IDs using a changed partition.
      const plan = createHash("sha256")
        .update("capture-chunks-v2:")
        .update(hash)
        .update(JSON.stringify(chunks))
        .digest("hex");
      const outputs = chunks.length ? await this.jobs.chunks(job, plan, chunks.length) : [];
      completedChunks = outputs.length;
      for (const [index, output] of outputs.entries()) {
        modelClaims.parse(output);
        validateClaims(output.claims, chunks[index]!);
      }
      if (outputs.length < chunks.length) {
        const index = outputs.length,
          chunk = chunks[index]!,
          input = extractionInput(chunk);
        // Chunk zero preserves the previous one-shot replay barrier for jobs
        // which might have dispatched before the chunked worker was deployed.
        const operationId = modelOperationId(
          job.id,
          index === 0 ? "capture-extraction-v1" : `capture-extraction-chunk-v2:${index}`,
        );
        const reservation = await this.admission.reserve(job.proof, {
          operationId,
          maxInputTokens: extractionInputBound(chunk),
          maxOutputTokens: 6000,
        });
        if (reservation.replay || reservation.state !== "held")
          throw new AppError("MODEL_RESERVATION_REPLAY", 409);
        try {
          await this.jobs.guard(job);
          await this.evidence.authorize(job.proof);
          const current = await this.evidence.read(job.proof);
          exactScope(job.proof, current);
          if (fingerprint(current) !== hash) throw new AppError("SOURCE_CHANGED", 409);
          // Source/authority reads can consume the remaining lease. Fence once
          // more immediately before provider I/O, not only before those RPCs.
          await this.jobs.guard(job);
        } catch (error) {
          await this.admission.record(
            job.proof,
            operationId,
            reservation.reservationId,
            "not_started",
          );
          throw error;
        }
        let output: unknown;
        try {
          output = await this.model.generate(input);
        } catch {
          await this.admission.record(job.proof, operationId, reservation.reservationId, "unknown");
          throw new AppError("MODEL_DISPATCH_UNKNOWN", 409);
        }
        await this.admission.record(job.proof, operationId, reservation.reservationId, "succeeded");
        const generated = modelClaims.parse(output);
        validateClaims(generated.claims, chunk);
        if (Buffer.byteLength(JSON.stringify([...outputs, generated]), "utf8") > 3_000_000)
          throw new AppError("EXTRACTION_OUTPUT_TOO_LARGE", 409);
        await this.evidence.authorize(job.proof);
        const after = await this.evidence.read(job.proof);
        exactScope(job.proof, after);
        if (fingerprint(after) !== hash) throw new AppError("SOURCE_CHANGED", 409);
        await this.jobs.checkpoint(job, plan, index, generated);
        outputs.push(generated);
        completedChunks = outputs.length;
        if (outputs.length < chunks.length) {
          await this.jobs.yield(job);
          return;
        }
      }
      const generated = mergeExtractionClaims(outputs);
      await this.evidence.authorize(job.proof);
      const current = await this.evidence.read(job.proof);
      exactScope(job.proof, current);
      if (fingerprint(current) !== hash) throw new AppError("SOURCE_CHANGED", 409);
      await this.jobs.guard(job);
      const result: Result = {
        ...generated,
        partial: snapshot.versions.some((row) => row.coverage !== "complete"),
        sourceFingerprint: hash,
        sourceVersions: snapshot.versions,
        reviewRequired: true,
      };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 3_050_000)
        throw new AppError("EXTRACTION_OUTPUT_TOO_LARGE", 409);
      await this.jobs.complete(job, result);
    } catch (error) {
      const code =
        error instanceof AppError || error instanceof ExtractionLimitError
          ? error.code
          : "EXTRACTION_VALIDATION_FAILED";
      // Admission/dispatch ambiguity is never retried as another paid model call.
      await this.jobs.fail(
        job,
        code,
        error instanceof AppError &&
          [429, 503].includes(error.status) &&
          job.attempts - completedChunks < 3,
      );
    }
  }
  private async user(actor: Actor, meetingId: string) {
    if (actor.operationGrantId || actor.sessionId.startsWith("operation:"))
      throw new AppError("FORBIDDEN", 403);
    await this.normalSources.requireActive(actor);
    await this.evidence.owner(actor, meetingId);
  }
  async list(actor: Actor, meetingId: string) {
    id.parse(meetingId);
    await this.user(actor, meetingId);
    const jobs = await this.jobs.list(actor, meetingId);
    await this.user(actor, meetingId);
    return { jobs: jobs.map((job) => this.view(job, false)) };
  }
  async load(actor: Actor, jobId: string) {
    if (actor.operationGrantId || actor.sessionId.startsWith("operation:"))
      throw new AppError("FORBIDDEN", 403);
    await this.normalSources.requireActive(actor);
    const job = await this.jobs.load(actor, id.parse(jobId));
    if (!job) throw new AppError("NOT_FOUND", 404);
    await this.user(actor, job.proof.meetingId);
    if (job.result) {
      const current = await this.normalSources.read(actor, {
        kind: "meeting",
        id: job.proof.meetingId,
      });
      const version = current.versions.find(
        (row) => row.meetingId === job.proof.meetingId && row.captureId === job.proof.captureId,
      );
      const snapshot: Snapshot = {
        versions: version ? [{ ...version, captureVersion: job.proof.transcriptRevision }] : [],
        evidence: current.evidence.filter((row) => row.captureId === job.proof.captureId),
      };
      if (fingerprint(snapshot) !== job.result.sourceFingerprint) {
        await this.jobs.invalidate(job);
        throw new AppError("SOURCE_CHANGED", 409);
      }
    }
    await this.user(actor, job.proof.meetingId);
    return this.view(job, true);
  }
  private view(job: CaptureExtractionJob, includeResult: boolean) {
    return {
      id: job.id,
      meetingId: job.proof.meetingId,
      captureId: job.proof.captureId,
      transcriptRevision: job.proof.transcriptRevision,
      status: job.status,
      errorCode: job.errorCode,
      createdAt: job.createdAt,
      ...(includeResult ? { result: job.result } : {}),
    };
  }
}
