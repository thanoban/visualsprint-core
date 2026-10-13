import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AppError,
  assertRuntimeRole,
  databasePool,
  migrate,
  type Actor,
} from "@visualsprint/platform";
import {
  DurablePreparation,
  UnconfiguredModelUsageAdmission,
  type PreparationContext,
  type ModelUsageAdmission,
} from "../../src/application/preparation-jobs.js";
import { PostgresPreparation } from "../../src/infrastructure/preparation-store.js";
import { PostgresIntelligence } from "../../src/infrastructure/store.js";
import { preparationApp } from "../../src/http/preparation-app.js";
import { intelligenceApp } from "../../src/http/app.js";
import { IntelligenceService } from "../../src/application/intelligence.js";
import { PostgresVectorIndexes } from "../../src/infrastructure/vector-indexes.js";
import type { Model, Sources } from "../../src/application/ports.js";
import type { Snapshot } from "../../src/domain/evidence.js";
const migration = databasePool(
  process.env.INTELLIGENCE_VECTOR_TEST_MIGRATION_URL ??
    "postgres://vs_intelligence_migration:local-migration-only@127.0.0.1:55443/intelligence",
  1,
);
const pool = databasePool(
  process.env.INTELLIGENCE_VECTOR_TEST_DATABASE_URL ??
    "postgres://vs_intelligence_runtime:local-runtime-only@127.0.0.1:55443/intelligence",
  3,
);
const repository = new PostgresPreparation(pool),
  intelligence = new PostgresIntelligence(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await migrate(migration, fileURLToPath(new URL("../../specs", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
function fixture(admission?: ModelUsageAdmission) {
  const actor: Actor = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      sessionId: "owner-session",
    },
    meetingId = randomUUID(),
    nextMeetingId = randomUUID(),
    captureId = randomUUID(),
    commitmentId = randomUUID();
  let active = true,
    modelCalls = 0,
    reservations = 0,
    targetVersion = 1,
    commitmentVersion = 1;
  const input = {
    meetingId: nextMeetingId,
    historyScope: { kind: "customer" as const, id: randomUUID() },
    confirmedScope: true as const,
  };
  let snapshot: Snapshot = {
    versions: [{ meetingId, version: 2, captureId, captureVersion: 3, coverage: "partial" }],
    evidence: [
      {
        meetingId,
        captureId,
        segmentId: randomUUID(),
        revision: 2,
        startMs: 0,
        endMs: 3000,
        text: "We will follow up next week.",
        speakerLabel: null,
      },
    ],
  };
  const sources: Sources = {
    async requireActive() {
      if (!active) throw new AppError("FORBIDDEN", 403);
    },
    async read() {
      if (!active) throw new AppError("FORBIDDEN", 403);
      return structuredClone(snapshot);
    },
  };
  const context: PreparationContext = {
    async authorizeScope() {
      return { meetings: [{ id: meetingId, version: 2 }] };
    },
    async meeting() {
      if (!active) throw new AppError("NOT_FOUND", 404);
      return { id: nextMeetingId, version: targetVersion };
    },
    async commitments() {
      return [
        {
          id: commitmentId,
          meetingId,
          version: commitmentVersion,
          text: "Ship migration",
          state: "unknown",
          dueAt: null,
          verifiedAt: null,
        },
      ];
    },
  };
  let handler: Model["generate"] = async () => ({ claims: [], unsupported: true });
  const model: Model = {
    async generate(input) {
      modelCalls++;
      return handler(input);
    },
  };
  const budget: ModelUsageAdmission = admission ?? {
    async reserve(_actor, input) {
      assert.equal(input.purpose, "preparation");
      assert.match(
        input.operationId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.equal(input.maxOutputTokens, 6000);
      assert(input.maxInputTokens > 4096);
      reservations++;
      return { reservationId: randomUUID(), replay: false, state: "held" as const };
    },
    async record() {},
  };
  const service = new DurablePreparation(repository, sources, context, model, budget);
  return {
    actor,
    meetingId,
    nextMeetingId,
    input,
    service,
    sources,
    model,
    get modelCalls() {
      return modelCalls;
    },
    get reservations() {
      return reservations;
    },
    set active(value: boolean) {
      active = value;
    },
    set handler(value: Model["generate"]) {
      handler = value;
    },
    set commitmentVersion(value: number) {
      commitmentVersion = value;
    },
    set targetVersion(value: number) {
      targetVersion = value;
    },
    set snapshot(value: Snapshot) {
      snapshot = value;
    },
    get snapshot() {
      return snapshot;
    },
  };
}
test("durable preparation queues once before model admission and persists owner-reviewed draft", async () => {
  const f = fixture(),
    key = randomUUID();
  const first = await f.service.request(f.actor, key, f.input);
  assert.equal(first.status, "queued");
  assert.equal(f.modelCalls, 0);
  assert.equal((await f.service.request(f.actor, key, f.input)).id, first.id);
  await assert.rejects(
    f.service.request(f.actor, key, { ...f.input, historyScope: { kind: "workspace", id: null } }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await Promise.all([
    f.service.work(f.actor.workspaceId, first.id),
    f.service.work(f.actor.workspaceId, first.id),
  ]);
  const complete = await f.service.status(f.actor, first.id);
  assert.equal(complete.status, "complete");
  assert.equal(complete.result!.reviewRequired, true);
  assert.equal(complete.result!.partial, true);
  assert.match(complete.result!.questions[0]!.text, /Verify current status/);
  assert.equal(f.modelCalls, 1);
  assert.equal(f.reservations, 1);
});
test("preparation owner/tenant isolation and accepted-commitment edits invalidate cached drafts", async () => {
  const f = fixture();
  const job = await f.service.request(f.actor, randomUUID(), f.input);
  await f.service.work(f.actor.workspaceId, job.id);
  await assert.rejects(
    f.service.status({ ...f.actor, actorId: randomUUID() }, job.id),
    /NOT_FOUND/,
  );
  await assert.rejects(
    f.service.status({ ...f.actor, workspaceId: randomUUID() }, job.id),
    /NOT_FOUND/,
  );
  assert.equal((await pool.query("SELECT * FROM preparation_jobs")).rows.length, 0);
  f.commitmentVersion = 2;
  const changed = await f.service.status(f.actor, job.id);
  assert.equal(changed.status, "invalidated");
  assert.equal(changed.result, null);
});
test("logout before dispatch and missing model admission never invoke a paid generation port", async () => {
  const f = fixture();
  const queued = await f.service.request(f.actor, randomUUID(), f.input);
  f.active = false;
  await f.service.work(f.actor.workspaceId, queued.id);
  assert.equal(f.modelCalls, 0);
  assert.equal(f.reservations, 0);
  const blocked = fixture(new UnconfiguredModelUsageAdmission());
  const job = await blocked.service.request(blocked.actor, randomUUID(), blocked.input);
  await blocked.service.work(blocked.actor.workspaceId, job.id);
  assert.equal(blocked.modelCalls, 0);
  assert.equal(
    (await blocked.service.status(blocked.actor, job.id)).errorCode,
    "MODEL_ADMISSION_NOT_CONFIGURED",
  );
});
test("target edit or permission loss during model execution prevents preparation publication", async () => {
  const f = fixture();
  const job = await f.service.request(f.actor, randomUUID(), f.input);
  f.handler = async () => {
    f.targetVersion = 2;
    return { claims: [], unsupported: true };
  };
  await f.service.work(f.actor.workspaceId, job.id);
  assert.equal((await f.service.status(f.actor, job.id)).status, "failed");
  assert.equal((await f.service.status(f.actor, job.id)).errorCode, "SOURCE_CHANGED");
  const revoked = fixture();
  const second = await revoked.service.request(revoked.actor, randomUUID(), revoked.input);
  revoked.handler = async () => {
    revoked.active = false;
    return { claims: [], unsupported: true };
  };
  await revoked.service.work(revoked.actor.workspaceId, second.id);
  assert.equal((await repository.load(revoked.actor, second.id))!.result, null);
});
test("revocation after admission records confirmed not-started cleanup without model dispatch", async () => {
  const outcomes: string[] = [];
  let f: ReturnType<typeof fixture>;
  const budget: ModelUsageAdmission = {
    async reserve() {
      f.active = false;
      return { reservationId: randomUUID(), replay: false, state: "held" as const };
    },
    async record(actor, _reservation, outcome) {
      assert.equal(actor.actorId, f.actor.actorId);
      outcomes.push(outcome);
    },
  };
  f = fixture(budget);
  const queued = await f.service.request(f.actor, randomUUID(), f.input);
  await f.service.work(f.actor.workspaceId, queued.id);
  assert.equal(f.modelCalls, 0);
  assert.deepEqual(outcomes, ["not_started"]);
  assert.equal((await repository.load(f.actor, queued.id))!.errorCode, "FORBIDDEN");
});
test("source/target deletion purges queued and in-flight preparation and fences resurrection", async () => {
  const f = fixture();
  const queued = await f.service.request(f.actor, randomUUID(), f.input);
  f.handler = async () => {
    await intelligence.scoped(f.actor.workspaceId, (tx) =>
      tx.purgeMeeting(f.meetingId, randomUUID(), 2),
    );
    await repository.purgeMeeting(f.actor.workspaceId, f.meetingId);
    return { claims: [], unsupported: true };
  };
  await f.service.work(f.actor.workspaceId, queued.id);
  assert.equal(await repository.load(f.actor, queued.id), null);
  await assert.rejects(f.service.request(f.actor, randomUUID(), f.input), /SOURCE_DELETED/);
  const target = fixture();
  const future = await target.service.request(target.actor, randomUUID(), target.input);
  await intelligence.scoped(target.actor.workspaceId, (tx) =>
    tx.purgeMeeting(target.nextMeetingId, randomUUID(), 1),
  );
  await repository.purgeMeeting(target.actor.workspaceId, target.nextMeetingId);
  assert.equal(await repository.load(target.actor, future.id), null);
});
test("preparation HTTP requires explicit scope confirmation, idempotency and user-only authority", async () => {
  const f = fixture(),
    grant = randomUUID();
  const app = preparationApp(f.service, async (token) =>
    token === "operation"
      ? { ...f.actor, operationGrantId: grant, sessionId: `operation:${grant}` }
      : f.actor,
  );
  const path = `/api/v3/workspaces/${f.actor.workspaceId}/intelligence/preparations`;
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: "Bearer owner" },
          payload: f.input,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: "Bearer operation", "idempotency-key": randomUUID() },
          payload: f.input,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: "Bearer owner", "idempotency-key": randomUUID() },
          payload: { ...f.input, confirmedScope: false },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: "Bearer owner", "idempotency-key": randomUUID() },
          payload: f.input,
        })
      ).statusCode,
      202,
    );
  } finally {
    await app.close();
  }
});
test("native Intelligence API registers durable preparation and awaits all installed owning cleanup", async () => {
  const f = fixture(),
    base = new IntelligenceService(intelligence, f.sources, f.model),
    vectors = new PostgresVectorIndexes(pool);
  let cleaned = false;
  const app = intelligenceApp(
    base,
    async () => f.actor,
    async () => f.actor,
    undefined,
    {
      preparation: f.service,
      purgeDerived: async (ws, id) => {
        await repository.purgeMeeting(ws, id);
        await vectors.purgeMeeting(ws, id);
        cleaned = true;
      },
    },
  );
  const path = `/api/v3/workspaces/${f.actor.workspaceId}/intelligence/preparations`;
  try {
    const queued = await app.inject({
      method: "POST",
      url: path,
      headers: { authorization: "Bearer owner", "idempotency-key": randomUUID() },
      payload: f.input,
    });
    assert.equal(queued.statusCode, 202);
    assert.equal(f.modelCalls, 0);
    const job = queued.json();
    await f.service.work(f.actor.workspaceId, job.id);
    const loaded = await app.inject({
      method: "GET",
      url: `${path}/${job.id}`,
      headers: { authorization: "Bearer owner" },
    });
    assert.equal(loaded.statusCode, 200);
    assert.equal(loaded.json().status, "complete");
    const deletionId = randomUUID();
    const deleted = await app.inject({
      method: "POST",
      url: `/internal/workspaces/${f.actor.workspaceId}/deletions/${deletionId}`,
      headers: { authorization: "Bearer workspace" },
      payload: { meetingId: f.meetingId, sourceVersion: 2 },
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().state, "complete");
    assert.equal(cleaned, true);
    assert.equal(await repository.load(f.actor, job.id), null);
  } finally {
    await app.close();
  }
});
