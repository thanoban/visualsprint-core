import test from "node:test";
import assert from "node:assert/strict";
import {
  modelBudgetFailure,
  modelTransition,
  type ModelBudget,
  type ModelUsageRequest,
} from "../src/domain/model-usage.js";
const budget: ModelBudget = {
  maxConcurrent: 2,
  monthlyInputTokens: 1000,
  monthlyOutputTokens: 100,
  active: 0,
  reservedInputTokens: 0,
  reservedOutputTokens: 0,
  consumedInputTokens: 0,
  consumedOutputTokens: 0,
};
const request: ModelUsageRequest = {
  operationId: "fixture",
  purpose: "preparation",
  maxInputTokens: 100,
  maxOutputTokens: 10,
};
test("model capacity bounds estimated input/output independently and embedding dimensions never consume output token quota", () => {
  assert.equal(modelBudgetFailure(budget, request), null);
  assert.equal(modelBudgetFailure({ ...budget, active: 2 }, request), "MODEL_CONCURRENCY_LIMIT");
  assert.equal(
    modelBudgetFailure({ ...budget, consumedInputTokens: 901 }, request),
    "MODEL_QUOTA_EXCEEDED",
  );
  assert.equal(
    modelBudgetFailure({ ...budget, reservedOutputTokens: 91 }, request),
    "MODEL_QUOTA_EXCEEDED",
  );
  assert.equal(
    modelBudgetFailure(
      { ...budget, monthlyOutputTokens: 0 },
      { ...request, purpose: "indexing", maxOutputTokens: 0 },
    ),
    null,
  );
});
test("unknown model outcomes remain held until confirmed success; replay and cleanup never authorize duplicate paid calls", () => {
  assert.equal(modelTransition("held", "unknown"), "change");
  assert.equal(modelTransition("unknown", "unknown"), "unchanged");
  assert.equal(modelTransition("unknown", "not_started"), "conflict");
  assert.equal(modelTransition("unknown", "succeeded"), "change");
  assert.equal(modelTransition("succeeded", "succeeded"), "unchanged");
  assert.equal(modelTransition("succeeded", "not_started"), "conflict");
  assert.equal(modelTransition("not_started", "unknown"), "conflict");
});
