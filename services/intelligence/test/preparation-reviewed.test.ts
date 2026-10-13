import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrepareNextMeeting } from "../src/application/preparation.js";
import type { ReviewedRecord, PreparationDraft } from "../src/domain/preparation.js";
import type { Snapshot } from "../src/domain/evidence.js";
test("preparation preserves human corrections and decisions without inventing external task completion", async () => {
  const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "owner" },
    meetingId = randomUUID(),
    targetId = randomUUID(),
    captureId = randomUUID(),
    segmentId = randomUUID();
  const history: Snapshot = {
    versions: [{ meetingId, version: 2, captureId, captureVersion: 4, coverage: "complete" }],
    evidence: [
      {
        meetingId,
        captureId,
        segmentId,
        revision: 3,
        startMs: 0,
        endMs: 1000,
        text: "We chose the old migration.",
        speakerLabel: null,
      },
    ],
  };
  const records: ReviewedRecord[] = [
    {
      id: randomUUID(),
      meetingId,
      version: 4,
      kind: "decision",
      title: "Revised decision",
      text: "Owner correction: use PostgreSQL instead.",
      state: "accepted",
      ownerId: actor.actorId,
      dueDate: null,
      statusSource: "human_review",
      updatedAt: new Date().toISOString(),
      citations: [{ captureId, segmentId, revision: 2 }],
      evidenceStatus: "changed",
      sourcePartial: false,
      externalStatus: "unknown",
      externalVerifiedAt: null,
    },
  ];
  let saved: PreparationDraft | undefined;
  const service = new PrepareNextMeeting(
    {
      async requireActive() {},
      async read() {
        return structuredClone(history);
      },
    },
    {
      async meeting() {
        return { id: targetId, version: 1 };
      },
      async commitments() {
        return [];
      },
      async records() {
        return structuredClone(records);
      },
    },
    {
      async generate() {
        return {
          claims: [
            {
              kind: "decision",
              text: "We chose the old migration.",
              citation: { meetingId, captureId, segmentId, revision: 3 },
            },
          ],
          unsupported: false,
        };
      },
    },
    {
      async save(_actor, _key, draft) {
        saved = draft;
        return { id: randomUUID() };
      },
    },
  );
  await service.execute(actor, randomUUID(), {
    meetingId: targetId,
    historyScope: { kind: "customer", id: randomUUID() },
    confirmedScope: true,
  });
  assert.equal(saved!.findings.length, 0);
  assert.equal(saved!.reviewedRecords![0]!.text, records[0]!.text);
  assert.equal(saved!.reviewedRecords![0]!.externalVerifiedAt, null);
  assert.equal(saved!.partial, true);
});
