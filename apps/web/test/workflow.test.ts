import test from "node:test";
import assert from "node:assert/strict";
import { operationMessage, workflowOperation } from "../src/workflow-model.js";
test("task UI never labels queued or ambiguous execution as confirmed", () => {
  for (const state of ["queued", "dispatching", "unknown", "reconciling"] as const)
    assert.equal(operationMessage(state).includes("creation confirmed"), false);
  assert.match(operationMessage("unknown"), /checking for the existing task before any retry/);
  assert.equal(operationMessage("confirmed"), "External task creation confirmed.");
  assert.throws(() =>
    workflowOperation.parse({
      id: crypto.randomUUID(),
      actionId: crypto.randomUUID(),
      state: "success",
      externalId: null,
      errorCode: null,
      version: 1,
    }),
  );
});
