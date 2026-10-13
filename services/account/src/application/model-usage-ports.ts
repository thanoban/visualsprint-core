import type { Actor } from "@visualsprint/platform";
import type {
  ModelBudget,
  ModelOutcome,
  ModelReservation,
  ModelUsageRequest,
  ModelPurpose,
} from "../domain/model-usage.js";
export interface ModelUsageTransaction {
  requireCurrent(): Promise<void>;
  lock(operationId: string, purpose: ModelPurpose): Promise<void>;
  budget(purpose: ModelPurpose): Promise<ModelBudget>;
  byOperation(operationId: string): Promise<ModelReservation | undefined>;
  reservation(reservationId: string): Promise<ModelReservation | undefined>;
  create(input: ModelUsageRequest): Promise<ModelReservation>;
  record(current: ModelReservation, outcome: ModelOutcome): Promise<ModelReservation>;
}
export interface ModelUsageRepository {
  transaction<T>(actor: Actor, work: (tx: ModelUsageTransaction) => Promise<T>): Promise<T>;
}
