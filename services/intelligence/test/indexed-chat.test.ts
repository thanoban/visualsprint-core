import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppError } from "@visualsprint/platform";
import { IndexedChatEvidence } from "../src/application/indexed-chat.js";
import { fingerprint, type Snapshot } from "../src/domain/evidence.js";
import { chunkEvidence } from "../src/domain/indexing.js";
const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "owner-session" };
function snapshot(): Snapshot {
  const meetingId = randomUUID(),
    captureId = randomUUID();
  return {
    versions: [{ meetingId, version: 2, captureId, captureVersion: 3, coverage: "complete" }],
    evidence: [
      {
        meetingId,
        captureId,
        segmentId: randomUUID(),
        revision: 2,
        startMs: 0,
        endMs: 1000,
        text: "Customer migration evidence ".repeat(300),
        speakerLabel: null,
      },
    ],
  };
}
test("indexed chat ranks only current authorized segments and deduplicates chunk citation identities", async () => {
  const source = snapshot(),
    scope = { kind: "project" as const, id: randomUUID() },
    jobId = randomUUID();
  const selection = new IndexedChatEvidence({
    async retrieve(actualActor, actualScope, query, key) {
      assert.deepEqual(actualActor, actor);
      assert.deepEqual(actualScope, scope);
      assert.equal(query, "migration");
      assert.equal(key, `chat:${jobId}`);
      return {
        sourceFingerprint: fingerprint(source),
        evidence: chunkEvidence(source.evidence),
        partial: false,
      };
    },
  });
  const selected = await selection.select(actor, scope, "migration", jobId, source);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.text, source.evidence[0]!.text);
});
test("missing indexes, unauthorized corrected chunks and changed fingerprints cannot silently fall back", async () => {
  const source = snapshot(),
    scope = { kind: "workspace" as const, id: null },
    jobId = randomUUID();
  const missing = new IndexedChatEvidence({
    async retrieve() {
      throw new AppError("INDEX_NOT_READY", 409);
    },
  });
  await assert.rejects(missing.select(actor, scope, "migration", jobId, source), /INDEX_NOT_READY/);
  const changed = new IndexedChatEvidence({
    async retrieve() {
      return {
        sourceFingerprint: "obsolete",
        evidence: chunkEvidence(source.evidence),
        partial: false,
      };
    },
  });
  await assert.rejects(changed.select(actor, scope, "migration", jobId, source), /SOURCE_CHANGED/);
  const injected = new IndexedChatEvidence({
    async retrieve() {
      return {
        sourceFingerprint: fingerprint(source),
        evidence: chunkEvidence(source.evidence).map((row) => ({ ...row, revision: 1 })),
        partial: false,
      };
    },
  });
  await assert.rejects(
    injected.select(actor, scope, "migration", jobId, source),
    /INDEX_SOURCE_MISMATCH/,
  );
});
