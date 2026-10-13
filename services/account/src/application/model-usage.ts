import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import { modelBudgetFailure, modelTransition } from "../domain/model-usage.js";
import type { ModelUsageRepository } from "./model-usage-ports.js";
const requestSchema = z
  .object({
    operationId: id,
    purpose: z.enum(["preparation", "summary", "chat", "indexing", "retrieval"]),
    maxInputTokens: z.number().int().min(1).max(250000),
    maxOutputTokens: z.number().int().min(0).max(6000),
  })
  .strict()
  .superRefine((input, context) => {
    const embedding = input.purpose === "indexing" || input.purpose === "retrieval";
    if (embedding ? input.maxOutputTokens !== 0 : input.maxOutputTokens < 1)
      context.addIssue({ code: "custom", message: "INVALID_MODEL_OUTPUT_ESTIMATE" });
    if (
      (input.purpose === "indexing" && input.maxInputTokens > 96000) ||
      (input.purpose === "retrieval" && input.maxInputTokens > 6000)
    )
      context.addIssue({ code: "custom", message: "INVALID_EMBEDDING_INPUT_ESTIMATE" });
  });
export class ModelUsageService {
  constructor(private readonly repository: ModelUsageRepository) {}
  private user(actor: Actor) {
    if (actor.operationGrantId || actor.sessionId.startsWith("operation:"))
      throw new AppError("FORBIDDEN", 403);
  }
  async reserve(actor: Actor, body: unknown) {
    this.user(actor);
    const input = requestSchema.parse(body);
    return this.repository.transaction(actor, async (tx) => {
      await tx.requireCurrent();
      await tx.lock(input.operationId, input.purpose);
      await tx.requireCurrent();
      const old = await tx.byOperation(input.operationId);
      if (old) {
        if (
          old.ownerId !== actor.actorId ||
          old.purpose !== input.purpose ||
          old.maxInputTokens !== input.maxInputTokens ||
          old.maxOutputTokens !== input.maxOutputTokens
        )
          throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        // Idempotency recovers the reservation, not permission to issue another model call.
        return { reservationId: old.reservationId, state: old.state, replay: true };
      }
      const failure = modelBudgetFailure(await tx.budget(input.purpose), input);
      if (failure) throw new AppError(failure, failure === "MODEL_CONCURRENCY_LIMIT" ? 429 : 402);
      const reservation = await tx.create(input);
      return { reservationId: reservation.reservationId, state: reservation.state, replay: false };
    });
  }
  async record(actor: Actor, reservationId: string, body: unknown) {
    this.user(actor);
    id.parse(reservationId);
    const { outcome } = z
      .object({ outcome: z.enum(["succeeded", "unknown", "not_started"]) })
      .strict()
      .parse(body);
    return this.repository.transaction(actor, async (tx) => {
      const reference = await tx.reservation(reservationId);
      if (!reference || reference.ownerId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
      await tx.lock(reference.operationId, reference.purpose);
      const current = await tx.reservation(reservationId);
      if (!current || current.ownerId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
      const transition = modelTransition(current.state, outcome);
      if (transition === "conflict") throw new AppError("MODEL_OUTCOME_CONFLICT", 409);
      const result = transition === "change" ? await tx.record(current, outcome) : current;
      // Cleanup after logout/member loss cannot fetch a prompt, transcript or model answer.
      return { reservationId: result.reservationId, state: result.state };
    });
  }
}
