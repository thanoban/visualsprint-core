import test from "node:test";
import assert from "node:assert/strict";
import {
  operationMessage,
  workflowOperation,
  actionDraft,
  externalTaskStatus,
} from "../src/workflow-model.js";
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
test("linked action contracts preserve exact accepted source version and never accept invented provider success", () => {
  const input = {
    connectionId: crypto.randomUUID(),
    provider: "jira",
    destination: "CORE",
    payload: { title: "Task", description: "Human review", dueDate: "2026-10-20" },
    source: {
      meetingId: crypto.randomUUID(),
      revision: 1,
      commitment: { id: crypto.randomUUID(), version: 2 },
    },
  };
  assert.deepEqual(actionDraft.parse(input).source.commitment, input.source.commitment);
  assert.equal(
    actionDraft.safeParse({
      ...input,
      source: { ...input.source, commitment: { ...input.source.commitment, version: 0 } },
    }).success,
    false,
  );
  assert.equal(
    actionDraft.safeParse({ ...input, payload: { ...input.payload, dueDate: "Tomorrow" } }).success,
    false,
  );
  assert.equal(
    externalTaskStatus.safeParse({
      operationId: crypto.randomUUID(),
      externalId: "CORE-1",
      state: "done",
      status: "Done",
      updatedAt: "2026-10-14",
      humanCommitmentCompleted: true,
    }).success,
    false,
  );
});
