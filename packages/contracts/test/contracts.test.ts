import test from "node:test";
import assert from "node:assert/strict";
import { confirmedAssignment, eventEnvelope, transcriptSegment } from "../src/index.js";

const uuid = "ab1ecfc0-9abd-45b0-8d6b-d627d470b02c";
const event = {
  eventId: uuid, type: "transcript.finalized.v1", schemaVersion: 1,
  workspaceId: uuid, aggregateId: uuid, aggregateVersion: 1,
  occurredAt: "2026-10-11T10:00:00.000Z",
  traceId: "a".repeat(32), actorId: uuid, references: [{ kind: "meeting", id: uuid }],
};

test("event envelopes reject transcript and credential fields", () => {
  assert.equal(eventEnvelope.safeParse(event).success, true);
  for (const extra of [{ text: "private" }, { payload: { token: "secret" } }]) {
    assert.equal(eventEnvelope.safeParse({ ...event, ...extra }).success, false);
  }
});
test("event envelopes require a tenant and versioned event type", () => {
  assert.equal(eventEnvelope.safeParse({ ...event, workspaceId: undefined }).success, false);
  assert.equal(eventEnvelope.safeParse({ ...event, type: "anything" }).success, false);
});
test("assignments require explicit confirmation and cannot grant sharing", () => {
  const assignment = { meetingId: uuid, projectId: uuid, expectedVersion: 1, confirmed: true };
  assert.equal(confirmedAssignment.safeParse(assignment).success, true);
  assert.equal(confirmedAssignment.safeParse({ ...assignment, confirmed: false }).success, false);
  assert.equal(confirmedAssignment.safeParse({ ...assignment, shareWithProject: true }).success, false);
});
test("transcript segments reject negative intervals and invented identity fields", () => {
  const segment = { sourceSegmentId: "s1", sourceRevision: 1, startMs: 20, endMs: 40,
    text: "Hello", speakerLabel: null, final: true };
  assert.equal(transcriptSegment.safeParse(segment).success, true);
  assert.equal(transcriptSegment.safeParse({ ...segment, endMs: 10 }).success, false);
  assert.equal(transcriptSegment.safeParse({ ...segment, verifiedPersonId: uuid }).success, false);
});
