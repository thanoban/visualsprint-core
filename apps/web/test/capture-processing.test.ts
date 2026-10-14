import test from "node:test";
import assert from "node:assert/strict";
import { captureProcessingSchema } from "../src/capture-processing-controls.js";
test("processing consent metadata keeps pending withdrawal and model completion distinct", () => {
  const pending = {
    state: "consent_pending",
    intentVersion: 1,
    consentId: null,
    consentVersion: null,
    policyVersion: "english-text-v1",
    transcriptRevision: 0,
    errorCode: null,
  };
  assert.equal(captureProcessingSchema.safeParse(pending).success, true);
  assert.equal(
    captureProcessingSchema.safeParse({ ...pending, state: "withdraw_requested" }).success,
    true,
  );
  assert.equal(captureProcessingSchema.safeParse({ ...pending, intentVersion: 0 }).success, false);
  assert.equal(
    captureProcessingSchema.safeParse({ ...pending, policyVersion: "any-language" }).success,
    false,
  );
  assert.equal(
    captureProcessingSchema.safeParse({ ...pending, state: "summary_complete" }).success,
    false,
  );
});
