import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { ModelUsageAdmission } from "../application/preparation-jobs.js";
import { IntelligenceInternalClient } from "./internal-client.js";
import { PostgresModelDispatch } from "./model-dispatch.js";
const reservation = z
  .object({
    reservationId: id,
    replay: z.boolean(),
    state: z.enum(["held", "succeeded", "unknown", "not_started"]),
  })
  .strict();
export class AccountModelUsageAdmission implements ModelUsageAdmission {
  constructor(
    private readonly client: IntelligenceInternalClient,
    private readonly dispatch: PostgresModelDispatch,
  ) {}
  async reserve(actor: Actor, input: Parameters<ModelUsageAdmission["reserve"]>[1]) {
    try {
      const result = reservation.parse(
        await this.client.post(
          actor,
          `/internal/workspaces/${id.parse(actor.workspaceId)}/model-usage/reservations`,
          input,
        ),
      );
      if (!result.replay && result.state === "held")
        await this.dispatch.intent(actor, input.operationId, result.reservationId);
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("INVALID_MODEL_ADMISSION", 503);
    }
  }
  async record(
    actor: Actor,
    reservationId: string,
    outcome: Parameters<ModelUsageAdmission["record"]>[2],
  ) {
    let result: { reservationId: string; state: string };
    try {
      result = z
        .object({
          reservationId: id,
          state: z.enum(["held", "succeeded", "unknown", "not_started"]),
        })
        .strict()
        .parse(
          await this.client.post(
            actor,
            `/internal/workspaces/${id.parse(actor.workspaceId)}/model-usage/reservations/${id.parse(reservationId)}/record`,
            { outcome },
          ),
        );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("INVALID_MODEL_ADMISSION", 503);
    }
    if (result.reservationId !== reservationId || result.state !== outcome)
      throw new AppError("INVALID_MODEL_ADMISSION", 503);
    await this.dispatch.record(actor, reservationId, outcome);
  }
}
