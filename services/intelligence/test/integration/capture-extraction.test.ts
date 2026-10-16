import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  AppError,
  type Actor,
} from "@visualsprint/platform";
import {
  DurableCaptureExtraction,
  type FinalizedCaptureProof,
  type CaptureExtractionAdmission,
} from "../../src/application/capture-extraction.js";
import { PostgresCaptureExtractions } from "../../src/infrastructure/capture-extraction-store.js";
import { PostgresIntelligence } from "../../src/infrastructure/store.js";
import { PostgresModelDispatch } from "../../src/infrastructure/model-dispatch.js";
import type { Snapshot } from "../../src/domain/evidence.js";
const migration = databasePool(
    process.env.INTELLIGENCE_TEST_MIGRATION_URL ??
      "postgres://vs_intelligence_migration:local-migration-only@127.0.0.1:55438/intelligence",
    1,
  ),
  pool = databasePool(
    process.env.INTELLIGENCE_TEST_DATABASE_URL ??
      "postgres://vs_intelligence_runtime:local-runtime-only@127.0.0.1:55438/intelligence",
    5,
  );
const jobs = new PostgresCaptureExtractions(pool),
  base = new PostgresIntelligence(pool),
  dispatch = new PostgresModelDispatch(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function query(workspaceId: string, text: string, values: unknown[] = []) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
    const result = await db.query(text, values);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
function fixture() {
  const proof: FinalizedCaptureProof = {
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    meetingId: randomUUID(),
    captureId: randomUUID(),
    consentId: randomUUID(),
    consentVersion: 1,
    transcriptRevision: 9,
    policyVersion: "english-text-v1",
  };
  const actor: Actor = {
    workspaceId: proof.workspaceId,
    actorId: proof.ownerId,
    sessionId: "owner",
  };
  const event = {
    eventId: randomUUID(),
    type: "capture.processing.ready.v1" as const,
    schemaVersion: 1 as const,
    workspaceId: proof.workspaceId,
    aggregateId: proof.captureId,
    aggregateVersion: proof.transcriptRevision,
    actorId: proof.ownerId,
    occurredAt: new Date().toISOString(),
    traceId: "f".repeat(32),
    references: [
      { kind: "meeting" as const, id: proof.meetingId },
      { kind: "capture" as const, id: proof.captureId, revision: 9 },
      { kind: "processing_consent" as const, id: proof.consentId, revision: 1 },
    ],
  };
  let allowed = true,
    modelUnknown = false,
    modelCalls = 0;
  let reads = 0,
    afterRead = async (_count: number) => {};
  const snapshot: Snapshot = {
    versions: [
      {
        meetingId: proof.meetingId,
        version: 1,
        captureId: proof.captureId,
        captureVersion: 9,
        coverage: "partial",
      },
    ],
    evidence: [
      {
        meetingId: proof.meetingId,
        captureId: proof.captureId,
        segmentId: randomUUID(),
        revision: 2,
        startMs: 0,
        endMs: 1000,
        text: "We will review the customer launch.",
        speakerLabel: null,
      },
    ],
  };
  const reservations = new Map<
    string,
    { id: string; state: "held" | "succeeded" | "unknown" | "not_started" }
  >();
  const admission: CaptureExtractionAdmission = {
    async reserve(_proof, input) {
      const old = reservations.get(input.operationId);
      if (old) return { reservationId: old.id, state: old.state, replay: true };
      const row = { id: randomUUID(), state: "held" as const };
      reservations.set(input.operationId, row);
      await dispatch.intent(actor, input.operationId, row.id);
      return { reservationId: row.id, state: row.state, replay: false };
    },
    async record(_proof, operationId, reservationId, outcome) {
      const row = reservations.get(operationId)!;
      assert.equal(row.id, reservationId);
      row.state = outcome;
      await dispatch.record(actor, reservationId, outcome);
    },
  };
  const service = new DurableCaptureExtraction(
    jobs,
    {
      async authorize(candidate) {
        assert.deepEqual(candidate, proof);
        if (!allowed) throw new AppError("PROCESSING_FORBIDDEN", 403);
      },
      async read() {
        if (!allowed) throw new AppError("PROCESSING_FORBIDDEN", 403);
        await afterRead(++reads);
        return structuredClone(snapshot);
      },
      async owner(candidate, meetingId) {
        if (candidate.actorId !== actor.actorId || meetingId !== proof.meetingId)
          throw new AppError("FORBIDDEN", 403);
      },
    },
    {
      async generate(input) {
        modelCalls++;
        if (modelUnknown) throw new Error("lost response");
        return {
          claims: [
            {
              kind: "discussion",
              text: input.evidence[0]!.text.slice(0, 100),
              citation: {
                meetingId: proof.meetingId,
                captureId: proof.captureId,
                segmentId: input.evidence[0]!.segmentId,
                revision: 2,
              },
            },
          ],
          unsupported: false,
        };
      },
    },
    admission,
    {
      async requireActive() {},
      async read() {
        return structuredClone(snapshot);
      },
    },
  );
  return {
    proof,
    actor,
    event,
    service,
    snapshot,
    get modelCalls() {
      return modelCalls;
    },
    set allowed(value: boolean) {
      allowed = value;
    },
    set modelUnknown(value: boolean) {
      modelUnknown = value;
    },
    set afterRead(value: (count: number) => Promise<void>) {
      afterRead = value;
    },
  };
}
test("concurrent event replay commits one private job/inbox and one worker claim under forced tenant RLS", async () => {
  const f = fixture(),
    accepted = await Promise.all(Array.from({ length: 6 }, () => f.service.consume(f.event)));
  assert.equal(new Set(accepted.map((row) => row.id)).size, 1);
  const jobId = accepted[0]!.id!;
  assert.equal(
    (
      await query(f.proof.workspaceId, "SELECT 1 FROM capture_extraction_inbox WHERE event_id=$1", [
        f.event.eventId,
      ])
    ).rowCount,
    1,
  );
  assert.equal(await jobs.load({ ...f.actor, workspaceId: randomUUID() }, jobId), null);
  assert.equal(await jobs.load({ ...f.actor, actorId: randomUUID() }, jobId), null);
  const claimed = await Promise.all(
    Array.from({ length: 4 }, () => jobs.claim(f.proof.workspaceId, jobId)),
  );
  assert.equal(claimed.filter(Boolean).length, 1);
  await assert.rejects(
    f.service.consume({ ...f.event, traceId: "a".repeat(32) }),
    /EVENT_REPLAY_CONFLICT/,
  );
});
test("durable extraction publishes only reviewable current evidence and purge removes private results/inbox/routing", async () => {
  const f = fixture(),
    accepted = await f.service.consume(f.event),
    jobId = accepted.id!;
  await f.service.work(f.proof.workspaceId, jobId);
  const result = await f.service.load(f.actor, jobId);
  assert.equal(result.status, "complete");
  assert.equal(result.result!.partial, true);
  assert.equal(result.result!.claims[0]!.citation.revision, 2);
  assert.equal(f.modelCalls, 1);
  const deletionId = randomUUID();
  await base.scoped(f.proof.workspaceId, (tx) => tx.purgeMeeting(f.proof.meetingId, deletionId, 1));
  await jobs.purgeMeeting(f.proof.workspaceId, f.proof.meetingId);
  assert.equal(await jobs.load(f.actor, jobId), null);
  assert.equal(
    (
      await query(
        f.proof.workspaceId,
        "SELECT 1 FROM capture_extraction_inbox WHERE meeting_id=$1",
        [f.proof.meetingId],
      )
    ).rowCount,
    0,
  );
  f.allowed = false;
  assert.deepEqual(await f.service.consume(f.event), { id: null, rejected: true });
  assert.equal(
    (
      await query(
        f.proof.workspaceId,
        "SELECT 1 FROM capture_extraction_inbox WHERE meeting_id=$1",
        [f.proof.meetingId],
      )
    ).rowCount,
    0,
  );
});
test("unknown model outcomes survive owning DB state and lease recovery never dispatches a second call", async () => {
  const f = fixture(),
    accepted = await f.service.consume(f.event),
    jobId = accepted.id!;
  f.modelUnknown = true;
  await f.service.work(f.proof.workspaceId, jobId);
  assert.equal((await jobs.load(f.actor, jobId))!.errorCode, "MODEL_DISPATCH_UNKNOWN");
  assert.equal(
    (
      await query(f.proof.workspaceId, "SELECT state FROM model_dispatches WHERE owner_id=$1", [
        f.actor.actorId,
      ])
    ).rows[0].state,
    "unknown",
  );
  await query(
    f.proof.workspaceId,
    "UPDATE capture_extraction_jobs SET status='queued' WHERE id=$1",
    [jobId],
  );
  await f.service.work(f.proof.workspaceId, jobId);
  assert.equal(f.modelCalls, 1);
  assert.equal((await jobs.load(f.actor, jobId))!.errorCode, "MODEL_RESERVATION_REPLAY");
});
test("hard revocation has durable rejected inbox semantics and cancels already-queued work without a poison retry", async () => {
  const rejected = fixture();
  rejected.allowed = false;
  assert.deepEqual(await rejected.service.consume(rejected.event), { id: null, rejected: true });
  assert.deepEqual(await rejected.service.consume(rejected.event), { id: null, rejected: true });
  const row = (
    await query(
      rejected.proof.workspaceId,
      "SELECT job_id,rejection_code FROM capture_extraction_inbox WHERE event_id=$1",
      [rejected.event.eventId],
    )
  ).rows[0];
  assert.equal(row.job_id, null);
  assert.equal(row.rejection_code, "PROCESSING_FORBIDDEN");
  const queued = fixture(),
    accepted = await queued.service.consume(queued.event);
  queued.allowed = false;
  await queued.service.consume(queued.event);
  assert.equal((await jobs.load(queued.actor, accepted.id!))!.status, "failed");
  await queued.service.work(queued.proof.workspaceId, accepted.id!);
  assert.equal(queued.modelCalls, 0);
});

test("owning lease expiry during the final source RPC prevents provider spend and records not-started", async () => {
  const f = fixture(),
    accepted = await f.service.consume(f.event),
    jobId = accepted.id!;
  f.afterRead = async (count) => {
    if (count === 2)
      await query(
        f.proof.workspaceId,
        "UPDATE capture_extraction_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
        [jobId],
      );
  };
  await f.service.work(f.proof.workspaceId, jobId);
  assert.equal(f.modelCalls, 0);
  assert.equal((await jobs.load(f.actor, jobId))!.errorCode, "EXTRACTION_LEASE_LOST");
  assert.equal(
    (
      await query(f.proof.workspaceId, "SELECT state FROM model_dispatches WHERE owner_id=$1", [
        f.actor.actorId,
      ])
    ).rows[0].state,
    "not_started",
  );
});

test("multi-chunk checkpoints survive new worker instances, are tenant isolated and cascade on coordinated deletion", async () => {
  const f = fixture();
  f.snapshot.evidence = Array.from({ length: 4 }, (_, index) => ({
    ...f.snapshot.evidence[0]!,
    segmentId: randomUUID(),
    text: `${index}: ${"meeting evidence ".repeat(6000)}`,
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
  }));
  const jobId = (await f.service.consume(f.event)).id!;
  await f.service.work(f.proof.workspaceId, jobId);
  assert.equal(f.modelCalls, 1);
  const checkpoint = (
    await query(
      f.proof.workspaceId,
      "SELECT outputs,chunk_count FROM capture_extraction_chunks WHERE job_id=$1",
      [jobId],
    )
  ).rows[0];
  assert.equal(checkpoint.outputs.length, 1);
  assert.equal(checkpoint.chunk_count, 4);
  assert.equal(
    (await query(randomUUID(), "SELECT 1 FROM capture_extraction_chunks WHERE job_id=$1", [jobId]))
      .rowCount,
    0,
  );
  // Recreating the store demonstrates that no in-memory progress is needed.
  const recreated = new PostgresCaptureExtractions(pool);
  for (let index = 1; index < 4; index++) await f.service.work(f.proof.workspaceId, jobId);
  assert.equal((await recreated.load(f.actor, jobId))!.status, "complete");
  assert.equal(f.modelCalls, 4);
  assert.equal((await recreated.load(f.actor, jobId))!.result!.claims.length, 4);
  await base.scoped(f.proof.workspaceId, (tx) =>
    tx.purgeMeeting(f.proof.meetingId, randomUUID(), 1),
  );
  await recreated.purgeMeeting(f.proof.workspaceId, f.proof.meetingId);
  assert.equal(
    (
      await query(f.proof.workspaceId, "SELECT 1 FROM capture_extraction_chunks WHERE job_id=$1", [
        jobId,
      ])
    ).rowCount,
    0,
  );
});

test("checkpoint writes require current lease and exact durable source plan", async () => {
  const f = fixture(),
    jobId = (await f.service.consume(f.event)).id!;
  const job = (await jobs.claim(f.proof.workspaceId, jobId))!;
  assert.deepEqual(await jobs.chunks(job, "plan-a", 2), []);
  await assert.rejects(jobs.chunks(job, "plan-b", 2), /SOURCE_CHANGED/);
  await assert.rejects(jobs.chunks(job, "plan-a", 3), /SOURCE_CHANGED/);
  const output = { claims: [], unsupported: true };
  await jobs.checkpoint(job, "plan-a", 0, output);
  await assert.rejects(jobs.checkpoint(job, "plan-a", 0, output), /EXTRACTION_CHECKPOINT_CONFLICT/);
  await query(
    f.proof.workspaceId,
    "UPDATE capture_extraction_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [jobId],
  );
  await assert.rejects(jobs.checkpoint(job, "plan-a", 1, output), /EXTRACTION_LEASE_LOST/);
  await assert.rejects(jobs.yield(job), /EXTRACTION_LEASE_LOST/);
  const resumed = (await jobs.claim(f.proof.workspaceId, jobId))!;
  assert.deepEqual(await jobs.chunks(resumed, "plan-a", 2), [output]);
});
