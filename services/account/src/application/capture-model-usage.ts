import { createHash } from "node:crypto";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import { modelBudgetFailure, modelTransition } from "../domain/model-usage.js";
import type { ModelUsageTransaction } from "./model-usage-ports.js";
import { captureConsentBinding } from "./capture-consent.js";
export const captureModelRequest = z
  .object({
    operationId: id,
    purpose: z.literal("capture_extraction"),
    proof: captureConsentBinding,
    transcriptRevision: z.number().int().positive(),
    maxInputTokens: z.number().int().min(1).max(250000),
    maxOutputTokens: z.number().int().min(1).max(6000),
  })
  .strict();
export type CaptureModelRequest = z.infer<typeof captureModelRequest>;
export type CaptureModelBinding = {
  reservationId: string;
  operationId: string;
  ownerId: string;
  consentId: string;
  fingerprint: string;
};
export const captureModelFingerprint = (input: CaptureModelRequest) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
export interface CaptureModelTransaction extends ModelUsageTransaction {
  requireCapture(input: CaptureModelRequest): Promise<void>;
  binding(reservationId: string): Promise<CaptureModelBinding | undefined>;
  bind(reservationId: string, input: CaptureModelRequest): Promise<void>;
}
export interface CaptureModelRepository {
  transaction<T>(actor: Actor, work: (tx: CaptureModelTransaction) => Promise<T>): Promise<T>;
}
export interface CaptureModelReadiness {
  assertReady(actor: Actor, input: CaptureModelRequest): Promise<void>;
}
export class CaptureModelUsageService {
  constructor(
    private readonly repository: CaptureModelRepository,
    private readonly readiness: CaptureModelReadiness,
    private readonly enabled = false,
  ) {}
  private actor(actor: Actor, consentId?: string) {
    if (
      !actor.operationGrantId ||
      actor.sessionId !== `operation:${actor.operationGrantId}` ||
      (consentId !== undefined && actor.operationGrantId !== consentId)
    )
      throw new AppError("FORBIDDEN", 403);
    id.parse(actor.operationGrantId);
  }
  async reserve(actor: Actor, body: unknown) {
    const input = captureModelRequest.parse(body);
    this.actor(actor, input.proof.consentId);
    if (!this.enabled) throw new AppError("CAPTURE_MODEL_ADMISSION_NOT_CONFIGURED", 503);
    // No owning DB transaction or source lock is held across the metadata-only callback.
    await this.repository.transaction(actor, (tx) => tx.requireCapture(input));
    await this.readiness.assertReady(actor, input);
    return this.repository.transaction(actor, async (tx) => {
      await tx.requireCapture(input);
      await tx.lock(input.operationId, input.purpose);
      await tx.requireCapture(input);
      const old = await tx.byOperation(input.operationId);
      if (old) {
        const binding = await tx.binding(old.reservationId);
        if (
          old.ownerId !== actor.actorId ||
          old.purpose !== input.purpose ||
          old.maxInputTokens !== input.maxInputTokens ||
          old.maxOutputTokens !== input.maxOutputTokens ||
          !binding ||
          binding.ownerId !== actor.actorId ||
          binding.consentId !== input.proof.consentId ||
          binding.operationId !== input.operationId ||
          binding.fingerprint !== captureModelFingerprint(input)
        )
          throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        return { reservationId: old.reservationId, state: old.state, replay: true };
      }
      const failure = modelBudgetFailure(await tx.budget(input.purpose), input);
      if (failure) throw new AppError(failure, failure === "MODEL_CONCURRENCY_LIMIT" ? 429 : 402);
      const reservation = await tx.create(input);
      await tx.bind(reservation.reservationId, input);
      return { reservationId: reservation.reservationId, state: reservation.state, replay: false };
    });
  }
  async record(actor: Actor, reservationId: string, body: unknown) {
    this.actor(actor);
    id.parse(reservationId);
    const input = z
      .object({ operationId: id, outcome: z.enum(["succeeded", "unknown", "not_started"]) })
      .strict()
      .parse(body);
    return this.repository.transaction(actor, async (tx) => {
      const reference = await tx.reservation(reservationId),
        binding = await tx.binding(reservationId);
      if (
        !reference ||
        reference.purpose !== "capture_extraction" ||
        reference.ownerId !== actor.actorId ||
        reference.operationId !== input.operationId ||
        !binding ||
        binding.ownerId !== actor.actorId ||
        binding.consentId !== actor.operationGrantId ||
        binding.operationId !== input.operationId
      )
        throw new AppError("NOT_FOUND", 404);
      await tx.lock(input.operationId, "capture_extraction");
      const current = await tx.reservation(reservationId);
      if (
        !current ||
        current.ownerId !== actor.actorId ||
        current.operationId !== input.operationId ||
        current.purpose !== "capture_extraction"
      )
        throw new AppError("NOT_FOUND", 404);
      const transition = modelTransition(current.state, input.outcome);
      if (transition === "conflict") throw new AppError("MODEL_OUTCOME_CONFLICT", 409);
      const result = transition === "change" ? await tx.record(current, input.outcome) : current;
      return { reservationId: result.reservationId, state: result.state };
    });
  }
}
