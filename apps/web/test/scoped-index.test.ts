import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { indexJobSchema } from "../src/scoped-index-panel.js";
test("index progress cannot claim complete before all chunks or accept a malformed source fingerprint", () => {
  const job = {
    id: randomUUID(),
    scope: { kind: "project", id: randomUUID() },
    status: "complete",
    cursor: 16,
    totalChunks: 16,
    sourceFingerprint: "a".repeat(64),
    errorCode: null,
    createdAt: "2026-10-14T00:00:00Z",
  };
  assert.equal(indexJobSchema.safeParse(job).success, true);
  assert.equal(indexJobSchema.safeParse({ ...job, cursor: 15 }).success, false);
  assert.equal(indexJobSchema.safeParse({ ...job, cursor: 17 }).success, false);
  assert.equal(
    indexJobSchema.safeParse({ ...job, sourceFingerprint: "client text" }).success,
    false,
  );
});
