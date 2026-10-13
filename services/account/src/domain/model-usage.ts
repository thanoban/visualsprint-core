export type ModelOutcome = "succeeded" | "unknown" | "not_started";
export type ModelReservationState = "held" | ModelOutcome;
export type ModelPurpose = "preparation" | "summary" | "chat" | "indexing" | "retrieval";
export type ModelUsageRequest = {
  operationId: string;
  purpose: ModelPurpose;
  maxInputTokens: number;
  maxOutputTokens: number;
};
export type ModelReservation = ModelUsageRequest & {
  workspaceId: string;
  reservationId: string;
  ownerId: string;
  period: string;
  state: ModelReservationState;
};
export type ModelBudget = {
  maxConcurrent: number;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  active: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  consumedInputTokens: number;
  consumedOutputTokens: number;
};
export function modelBudgetFailure(budget: ModelBudget, request: ModelUsageRequest) {
  if (budget.active >= budget.maxConcurrent) return "MODEL_CONCURRENCY_LIMIT";
  if (
    budget.reservedInputTokens + budget.consumedInputTokens + request.maxInputTokens >
      budget.monthlyInputTokens ||
    budget.reservedOutputTokens + budget.consumedOutputTokens + request.maxOutputTokens >
      budget.monthlyOutputTokens
  )
    return "MODEL_QUOTA_EXCEEDED";
  return null;
}
export function modelTransition(current: ModelReservationState, outcome: ModelOutcome) {
  if (current === outcome) return "unchanged";
  if (current === "held" || (current === "unknown" && outcome === "succeeded")) return "change";
  // Unknown calls cannot be released without independently qualified no-start proof.
  return "conflict";
}
