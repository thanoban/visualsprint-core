import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppError } from "@visualsprint/platform";
import { commitmentQuestions } from "../src/domain/preparation.js";
import { PrepareNextMeeting } from "../src/application/preparation.js";
import { NarrowCaptureExtraction } from "../src/application/capture-processing.js";
import type { Snapshot } from "../src/domain/evidence.js";
const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "session" };
const meetingId = randomUUID(),
  captureId = randomUUID(),
  nextMeetingId = randomUUID();
const snapshot: Snapshot = {
  versions: [{ meetingId, version: 2, captureId, captureVersion: 4, coverage: "partial" }],
  evidence: [
    {
      meetingId,
      captureId,
      segmentId: randomUUID(),
      revision: 2,
      startMs: 0,
      endMs: 2000,
      text: "We decided to migrate next week.",
      speakerLabel: null,
    },
  ],
};
test("preparation asks about uncertain task status and never treats AI inference as completion", () => {
  const base = {
    id: randomUUID(),
    meetingId,
    version: 1,
    text: "Ship migration",
    dueAt: "2026-10-10T00:00:00Z",
    verifiedAt: null,
  };
  const questions = commitmentQuestions(
    [
      { ...base, state: "done" },
      { ...base, id: randomUUID(), state: "open", verifiedAt: "2026-10-13T00:00:00Z" },
      { ...base, id: randomUUID(), state: "done", verifiedAt: "2026-10-13T00:00:00Z" },
    ],
    new Set([meetingId]),
    new Date("2026-10-13T00:00:00Z"),
  );
  assert.equal(questions.length, 2);
  assert.match(questions[0]!.text, /Verify current status/);
  assert.match(questions[1]!.text, /overdue/);
  assert.throws(
    () =>
      commitmentQuestions(
        [{ ...base, state: "open", meetingId: randomUUID() }],
        new Set([meetingId]),
        new Date(),
      ),
    /COMMITMENT_SCOPE_MISMATCH/,
  );
});
test("owner-confirmed history produces a reviewable partial agenda and rechecks target revisions", async () => {
  let version = 1,
    saved = false;
  const service = new PrepareNextMeeting(
    {
      async requireActive() {},
      async read() {
        return snapshot;
      },
    },
    {
      async meeting() {
        return { id: nextMeetingId, version };
      },
      async commitments() {
        return [];
      },
    },
    {
      async generate() {
        return { claims: [], unsupported: true };
      },
    },
    {
      async save(_actor, _key, draft) {
        assert.equal(draft.partial, true);
        assert.equal(draft.reviewRequired, true);
        assert.equal(draft.meetingId, nextMeetingId);
        saved = true;
        return { id: randomUUID() };
      },
    },
  );
  await service.execute(actor, randomUUID(), {
    meetingId: nextMeetingId,
    historyScope: { kind: "customer", id: randomUUID() },
    confirmedScope: true,
  });
  assert.equal(saved, true);
  await assert.rejects(
    service.execute(actor, randomUUID(), {
      meetingId: nextMeetingId,
      historyScope: { kind: "workspace", id: null },
      confirmedScope: false,
    }),
  );
  saved = false;
  const changed = new PrepareNextMeeting(
    {
      async requireActive() {},
      async read() {
        return snapshot;
      },
    },
    {
      async meeting() {
        return { id: nextMeetingId, version };
      },
      async commitments() {
        return [];
      },
    },
    {
      async generate() {
        version++;
        return { claims: [], unsupported: true };
      },
    },
    {
      async save() {
        saved = true;
        return { id: randomUUID() };
      },
    },
  );
  await assert.rejects(
    changed.execute(actor, randomUUID(), {
      meetingId: nextMeetingId,
      historyScope: { kind: "meeting", id: meetingId },
      confirmedScope: true,
    }),
    /SOURCE_CHANGED/,
  );
  assert.equal(saved, false);
});
test("narrow capture processing never accepts a project scope or mismatched capture evidence", async () => {
  let published = false,
    authorized = true;
  const proof = {
    schemaVersion: 1 as const,
    workspaceId: actor.workspaceId,
    ownerId: actor.actorId,
    meetingId,
    captureId,
    consentId: randomUUID(),
    consentVersion: 1,
    captureRevision: 4,
    purpose: "finalized_capture_extraction" as const,
    policyVersion: "english-text-v1" as const,
  };
  const queue = {
    async enqueue() {
      return { id: randomUUID() };
    },
    async publish() {
      published = true;
    },
  };
  const service = new NarrowCaptureExtraction(
    {
      async authorize() {
        if (!authorized) throw new AppError("FORBIDDEN", 403);
      },
    },
    {
      async read() {
        return snapshot;
      },
    },
    queue,
    {
      async generate() {
        return { claims: [], unsupported: true };
      },
    },
  );
  await service.execute(proof);
  assert.equal(published, true);
  await assert.rejects(service.enqueue({ ...proof, scope: { kind: "project", id: randomUUID() } }));
  const mismatched = new NarrowCaptureExtraction(
    { async authorize() {} },
    {
      async read() {
        return { ...snapshot, evidence: [{ ...snapshot.evidence[0]!, captureId: randomUUID() }] };
      },
    },
    queue,
    {
      async generate() {
        throw new Error("must not run");
      },
    },
  );
  await assert.rejects(mismatched.execute(proof), /PROCESSING_SCOPE_MISMATCH/);
  published = false;
  const revoked = new NarrowCaptureExtraction(
    {
      async authorize() {
        if (!authorized) throw new AppError("FORBIDDEN", 403);
      },
    },
    {
      async read() {
        return snapshot;
      },
    },
    queue,
    {
      async generate() {
        authorized = false;
        return { claims: [], unsupported: true };
      },
    },
  );
  await assert.rejects(revoked.execute(proof), /FORBIDDEN/);
  assert.equal(published, false);
});
