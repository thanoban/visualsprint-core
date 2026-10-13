import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fingerprint,
  selectEvidence,
  validateClaims,
  type Claim,
  type Evidence,
  type Snapshot,
} from "../src/domain/evidence.js";
import { modelClaims, scope } from "../src/application/schemas.js";
const evidence: Evidence = {
  meetingId: randomUUID(),
  captureId: randomUUID(),
  segmentId: randomUUID(),
  revision: 2,
  startMs: 0,
  endMs: 3000,
  text: "We will ship the migration on Friday.",
  speakerLabel: null,
};
const snapshot: Snapshot = {
  versions: [
    {
      meetingId: evidence.meetingId,
      version: 1,
      captureId: evidence.captureId,
      captureVersion: 3,
      coverage: "partial",
    },
  ],
  evidence: [evidence],
};
const claim: Claim = {
  kind: "commitment",
  text: "ship the migration on Friday",
  citation: {
    meetingId: evidence.meetingId,
    captureId: evidence.captureId,
    segmentId: evidence.segmentId,
    revision: 2,
  },
};
test("extractive evidence requires exact tenant-authorized source IDs, correction revision and contiguous text", () => {
  validateClaims([claim], [evidence]);
  for (const invalid of [
    { ...claim, text: "The migration was shipped." },
    { ...claim, citation: { ...claim.citation, revision: 1 } },
    { ...claim, citation: { ...claim.citation, meetingId: randomUUID() } },
  ])
    assert.throws(() => validateClaims([invalid], [evidence]), /UNSUPPORTED_CLAIM/);
});
test("fingerprint includes correction text, revisions, permission scope and coverage", () => {
  const original = fingerprint(snapshot);
  assert.notEqual(
    fingerprint({ ...snapshot, evidence: [{ ...evidence, text: "Human correction" }] }),
    original,
  );
  assert.notEqual(fingerprint({ ...snapshot, versions: [] }), original);
  assert.notEqual(
    fingerprint({ ...snapshot, versions: [{ ...snapshot.versions[0]!, coverage: "complete" }] }),
    original,
  );
});
test("bounded chat retrieval ranks relevant sources while summary never silently truncates", () => {
  const many = Array.from({ length: 150 }, (_, index) => ({
    ...evidence,
    segmentId: randomUUID(),
    text: index === 149 ? "Customer migration budget" : "Unrelated discussion",
  }));
  const selected = selectEvidence({ ...snapshot, evidence: many }, "migration budget");
  assert.equal(selected.length, 100);
  assert.equal(selected[0]!.text, "Customer migration budget");
  assert.throws(
    () =>
      selectEvidence(
        {
          ...snapshot,
          evidence: Array.from({ length: 10 }, () => ({ ...evidence, text: "x".repeat(20000) })),
        },
        null,
      ),
    /EVIDENCE_TOO_LARGE/,
  );
});
test("model output cannot inject actions, owners or unsupported scope fields", () => {
  assert.throws(() =>
    modelClaims.parse({ claims: [{ ...claim, ownerId: randomUUID() }], unsupported: false }),
  );
  assert.throws(() =>
    modelClaims.parse({ claims: [claim], unsupported: false, toolCall: "send_email" }),
  );
  assert.throws(() => scope.parse({ kind: "project", id: null }));
  assert.throws(() => scope.parse({ kind: "workspace", id: randomUUID() }));
});
