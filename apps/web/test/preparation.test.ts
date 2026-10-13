import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { preparationJob } from "../src/preparation-panel.js";

test("preparation client accepts opaque pending jobs but requires explicit review and human-only external status", () => {
  const pending = {
    id: randomUUID(),
    status: "queued",
    result: null,
    errorCode: null,
    attempts: 0,
    createdAt: "2026-10-14T00:00:00Z",
  };
  assert.equal(preparationJob.safeParse(pending).success, true);
  const record = {
    id: randomUUID(),
    meetingId: randomUUID(),
    version: 1,
    kind: "commitment",
    title: "Human record",
    text: "Reviewed statement",
    state: "completed",
    ownerId: null,
    dueDate: null,
    statusSource: "human_review",
    evidenceStatus: "changed",
    sourcePartial: true,
    citations: [],
    externalStatus: "unknown",
    externalVerifiedAt: null,
  };
  const result = {
    meetingId: randomUUID(),
    meetingVersion: 1,
    historyScope: { kind: "workspace", id: null },
    sourceFingerprint: "fixture",
    sourceVersions: [],
    findings: [],
    questions: [],
    reviewedRecords: [record],
    partial: true,
    reviewRequired: true,
  };
  assert.equal(preparationJob.safeParse({ ...pending, status: "complete", result }).success, true);
  assert.equal(
    preparationJob.safeParse({
      ...pending,
      status: "complete",
      result: { ...result, reviewRequired: false },
    }).success,
    false,
  );
  assert.equal(
    preparationJob.safeParse({
      ...pending,
      status: "complete",
      result: {
        ...result,
        reviewedRecords: [
          { ...record, externalStatus: "completed", externalVerifiedAt: "2026-10-14T00:00:00Z" },
        ],
      },
    }).success,
    false,
  );
  assert.equal(
    preparationJob.safeParse({
      ...pending,
      status: "complete",
      result: { ...result, historyScope: { kind: "project", id: null } },
    }).success,
    false,
  );
});
