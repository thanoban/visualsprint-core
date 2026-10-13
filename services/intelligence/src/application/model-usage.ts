import { createHash } from "node:crypto";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { ModelUsageAdmission } from "./preparation-jobs.js";
import type { Model, Sources } from "./ports.js";
export function modelOperationId(namespace: string, command: string) {
  id.parse(namespace);
  const bytes = createHash("sha1").update(namespace).update(command).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function admittedGeneration(
  actor: Actor,
  operationId: string,
  purpose: "summary" | "chat" | "preparation",
  input: Parameters<Model["generate"]>[0],
  model: Model,
  sources: Sources,
  admission: ModelUsageAdmission,
  authorizeBeforeDispatch?: () => Promise<void>,
) {
  const maximum = Buffer.byteLength(JSON.stringify(input), "utf8") + 4096;
  if (maximum > 250000) throw new AppError("MODEL_INPUT_TOO_LARGE", 409);
  const reservation = await admission.reserve(actor, {
    operationId,
    purpose,
    maxInputTokens: maximum,
    maxOutputTokens: 6000,
  });
  id.parse(reservation.reservationId);
  if (reservation.replay || reservation.state !== "held")
    throw new AppError("MODEL_RESERVATION_REPLAY", 409);
  try {
    await sources.requireActive(actor);
    await authorizeBeforeDispatch?.();
  } catch (error) {
    await admission.record(actor, reservation.reservationId, "not_started");
    throw error;
  }
  let output: unknown;
  try {
    output = await model.generate(input);
  } catch {
    await admission.record(actor, reservation.reservationId, "unknown");
    // The model may have completed and charged despite a lost response. Never
    // create another attempt blindly; operator/provider reconciliation is needed.
    throw new AppError("MODEL_DISPATCH_UNKNOWN", 409);
  }
  await admission.record(actor, reservation.reservationId, "succeeded");
  return output;
}
