import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { databasePool, migrate, assertRuntimeRole, AppError } from "@visualsprint/platform";
import { PostgresCapture } from "../../src/infrastructure/store.js";
import { PostgresCaptureProcessing } from "../../src/infrastructure/capture-processing-store.js";
import { PostgresCapturePublications } from "../../src/infrastructure/capture-processing-publication-store.js";
import {
  CaptureProcessingService,
  type ProcessingAuthority,
} from "../../src/application/capture-processing.js";
import { CaptureProcessingPublisher } from "../../src/application/capture-processing-publication.js";
const migration = databasePool(
    process.env.INGEST_TEST_MIGRATION_URL ??
      "postgres://vs_ingest_migration:local-migration-only@127.0.0.1:55436/ingest",
    1,
  ),
  pool = databasePool(
    process.env.INGEST_TEST_DATABASE_URL ??
      "postgres://vs_ingest_runtime:local-runtime-only@127.0.0.1:55436/ingest",
    5,
  );
const captures = new PostgresCapture(pool),
  intents = new PostgresCaptureProcessing(pool),
  publications = new PostgresCapturePublications(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function scopedQuery(workspaceId: string, query: string, values: unknown[] = []) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
    const result = await db.query(query, values);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function fixture() {
  const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "capture-owner" },
    meetingId = randomUUID(),
    consentId = randomUUID();
  const capture = await captures.scoped(actor.workspaceId, (tx) =>
    tx.insert({
      actor,
      context: {
        meetingId,
        ownerId: actor.actorId,
        version: 1,
        joinUrl: "https://meet.google.com/abc-defg-hij",
      },
      maxSeconds: 120,
      processing: true,
    }),
  );
  const intent = (await intents.intent(actor.workspaceId, capture.id))!;
  await intents.bind(intent, { consentId, version: 1 });
  const segment = {
    id: randomUUID(),
    revision: 1,
    startMs: 0,
    endMs: 1000,
    text: "Evidence persists through meeting end.",
    speakerLabel: null,
    finalized: true,
  };
  await captures.scoped(actor.workspaceId, async (tx) => {
    await tx.storeSegment(capture.id, segment);
    await tx.update(capture.id, { state: "complete", coverage: "no_detected_gaps" });
  });
  let denial: AppError | null = null;
  const unused = async (): Promise<never> => {
    throw new Error("unused source port");
  };
  const authority: ProcessingAuthority = {
    owner: unused,
    create: unused,
    withdraw: unused,
    cleanup: unused,
    async grant() {
      if (denial) throw denial;
      return {
        consentId,
        workspaceId: actor.workspaceId,
        ownerId: actor.actorId,
        meetingId,
        captureId: capture.id,
        version: 1,
        policyVersion: "english-text-v1",
        active: true,
      };
    },
    async workspace() {
      return { meetingId, ownerId: actor.actorId, meetingVersion: 1 };
    },
  };
  const processing = new CaptureProcessingService(intents, authority);
  return {
    actor,
    meetingId,
    capture,
    segment,
    processing,
    publisher: new CaptureProcessingPublisher(publications, processing),
    set denial(value: AppError | null) {
      denial = value;
    },
  };
}
test("finalization routes processing once, concurrent publishers atomically persist one metadata event and forcedRLS hides rows", async () => {
  const f = await fixture();
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM capture_processing_publish_index WHERE workspace_id=$1 AND capture_id=$2",
        [f.actor.workspaceId, f.capture.id],
      )
    ).rowCount,
    1,
  );
  await Promise.all(
    Array.from({ length: 6 }, () => f.publisher.work(f.actor.workspaceId, f.capture.id)),
  );
  const rows = await scopedQuery(
    f.actor.workspaceId,
    "SELECT p.event_id,o.event FROM capture_processing_publications p JOIN outbox o ON o.workspace_id=p.workspace_id AND o.id=p.event_id WHERE p.capture_id=$1",
    [f.capture.id],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].event.type, "capture.processing.ready.v1");
  assert.equal(
    rows.rows[0].event.aggregateVersion,
    (await intents.capture(f.actor.workspaceId, f.capture.id))!.transcriptRevision,
  );
  await f.publisher.work(f.actor.workspaceId, f.capture.id);
  assert.equal(
    (
      await scopedQuery(
        f.actor.workspaceId,
        "SELECT 1 FROM capture_processing_publications WHERE capture_id=$1",
        [f.capture.id],
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await scopedQuery(
        randomUUID(),
        "SELECT 1 FROM capture_processing_publications WHERE capture_id=$1",
        [f.capture.id],
      )
    ).rowCount,
    0,
  );
});
test("human text correction wakes a new transcript generation but quota bookkeeping does not", async () => {
  const f = await fixture();
  await f.publisher.work(f.actor.workspaceId, f.capture.id);
  await captures.scoped(f.actor.workspaceId, (tx) =>
    tx.update(f.capture.id, { quotaState: "settled" }),
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM capture_processing_publish_index WHERE capture_id=$1", [
        f.capture.id,
      ])
    ).rowCount,
    0,
  );
  await captures.scoped(f.actor.workspaceId, (tx) =>
    tx.storeSegment(f.capture.id, { ...f.segment, revision: 2, text: "Corrected human evidence" }),
  );
  await f.publisher.work(f.actor.workspaceId, f.capture.id);
  const rows = await scopedQuery(
    f.actor.workspaceId,
    "SELECT transcript_revision,event_id FROM capture_processing_publications WHERE capture_id=$1 ORDER BY transcript_revision",
    [f.capture.id],
  );
  assert.equal(rows.rowCount, 2);
  assert.notEqual(rows.rows[0].event_id, rows.rows[1].event_id);
  const proof = {
    consentId: (await intents.intent(f.actor.workspaceId, f.capture.id))!.consentId!,
    expectedVersion: 1,
    meetingId: f.meetingId,
    captureId: f.capture.id,
    policyVersion: "english-text-v1",
  };
  const revision = (await intents.capture(f.actor.workspaceId, f.capture.id))!.transcriptRevision;
  assert.equal(
    (
      await f.processing.readyContext(
        {
          ...f.actor,
          operationGrantId: proof.consentId,
          sessionId: `operation:${proof.consentId}`,
        },
        f.capture.id,
        { proof, transcriptRevision: revision },
      )
    ).ready,
    true,
  );
});
test("pending withdrawal and deletion remove publication routing; stale publication candidates cannot revive it", async () => {
  const f = await fixture(),
    candidate = (await publications.candidate(f.actor.workspaceId, f.capture.id))!;
  await intents.withdraw(f.actor, randomUUID(), f.capture.id, 1);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM capture_processing_publish_index WHERE capture_id=$1", [
        f.capture.id,
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(
    publications.commit(candidate, { rejectionCode: "FORBIDDEN" }),
    /PROCESSING_CONTEXT_CHANGED/,
  );
  const deleted = await fixture();
  await captures.scoped(deleted.actor.workspaceId, (tx) =>
    tx.deleteMeeting(deleted.meetingId, randomUUID(), 1),
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM capture_processing_publish_index WHERE capture_id=$1", [
        deleted.capture.id,
      ])
    ).rowCount,
    0,
  );
  assert.equal(await publications.candidate(deleted.actor.workspaceId, deleted.capture.id), null);
});
test("revoked authority is durably rejected once while transient failure retains retryable routing without an outbox event", async () => {
  const revoked = await fixture();
  revoked.denial = new AppError("FORBIDDEN", 403);
  await revoked.publisher.work(revoked.actor.workspaceId, revoked.capture.id);
  const rejection = (
    await scopedQuery(
      revoked.actor.workspaceId,
      "SELECT state,event_id,rejection_code FROM capture_processing_publications WHERE capture_id=$1",
      [revoked.capture.id],
    )
  ).rows[0];
  assert.deepEqual(rejection, { state: "rejected", event_id: null, rejection_code: "FORBIDDEN" });
  const unknown = await fixture();
  unknown.denial = new AppError("UNKNOWN_AUTHORITY", 503);
  await unknown.publisher.work(unknown.actor.workspaceId, unknown.capture.id);
  assert.equal(
    (
      await scopedQuery(
        unknown.actor.workspaceId,
        "SELECT 1 FROM capture_processing_publications WHERE capture_id=$1",
        [unknown.capture.id],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM capture_processing_publish_index WHERE capture_id=$1", [
        unknown.capture.id,
      ])
    ).rowCount,
    1,
  );
});
