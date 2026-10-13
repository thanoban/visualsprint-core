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
import { IntelligenceService } from "../../src/application/intelligence.js";
import { PostgresIntelligence } from "../../src/infrastructure/store.js";
import { intelligenceApp } from "../../src/http/app.js";
import { fingerprint, type Snapshot } from "../../src/domain/evidence.js";
import type { Model, Sources } from "../../src/application/ports.js";
const migrationPool = databasePool(
  process.env.INTELLIGENCE_TEST_MIGRATION_URL ??
    "postgres://vs_intelligence_migration:local-migration-only@127.0.0.1:55438/intelligence",
  1,
);
const pool = databasePool(
  process.env.INTELLIGENCE_TEST_DATABASE_URL ??
    "postgres://vs_intelligence_runtime:local-runtime-only@127.0.0.1:55438/intelligence",
  4,
);
const repository = new PostgresIntelligence(pool);
before(async () => {
  await migrate(migrationPool, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migrationPool.end();
});
function setup() {
  const actor: Actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    sessionId: "user-session",
  };
  const meetingId = randomUUID(),
    captureId = randomUUID(),
    segmentId = randomUUID();
  let active = true,
    allowed = true,
    calls = 0;
  let snapshot: Snapshot = {
    versions: [{ meetingId, version: 1, captureId, captureVersion: 2, coverage: "complete" }],
    evidence: [
      {
        meetingId,
        captureId,
        segmentId,
        revision: 2,
        startMs: 0,
        endMs: 4000,
        text: "We will migrate to PostgreSQL next week.",
        speakerLabel: "Speaker 1",
      },
    ],
  };
  const sources: Sources = {
    async requireActive() {
      if (!active) throw new AppError("FORBIDDEN", 403);
    },
    async read() {
      if (!active || !allowed) throw new AppError("NOT_FOUND", 404);
      return structuredClone(snapshot);
    },
  };
  let handler: Model["generate"] = async (input) => ({
    claims: [
      {
        kind: "commitment",
        text: "migrate to PostgreSQL next week",
        citation: { meetingId, captureId, segmentId, revision: input.evidence[0]!.revision },
      },
    ],
    unsupported: false,
  });
  const model: Model = {
    async generate(input) {
      calls++;
      return handler(input);
    },
  };
  const service = new IntelligenceService(repository, sources, model);
  return {
    actor,
    meetingId,
    service,
    model,
    sources,
    get snapshot() {
      return snapshot;
    },
    set snapshot(value) {
      snapshot = value;
    },
    set active(value: boolean) {
      active = value;
    },
    set allowed(value: boolean) {
      allowed = value;
    },
    set handler(value: Model["generate"]) {
      handler = value;
    },
    get calls() {
      return calls;
    },
  };
}
test("summary commands persist once, workers publish source-linked reviewable proposals and metadata-only outbox", async () => {
  const fixture = setup(),
    key = randomUUID();
  const first = await fixture.service.summary(fixture.actor, key, { meetingId: fixture.meetingId });
  assert.equal(
    (await fixture.service.summary(fixture.actor, key, { meetingId: fixture.meetingId })).id,
    first.id,
  );
  await assert.rejects(
    fixture.service.summary(fixture.actor, key, { meetingId: randomUUID() }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await Promise.all([
    fixture.service.work(fixture.actor.workspaceId, first.id),
    fixture.service.work(fixture.actor.workspaceId, first.id),
  ]);
  const result = await fixture.service.job(fixture.actor, first.id);
  assert.equal(result.status, "complete");
  assert.equal(result.result!.claims[0]!.citation.revision, 2);
  assert.equal(result.result!.reviewRequired, true);
  assert.equal(fixture.calls, 1);
  const events = await pool.query("SELECT event FROM outbox WHERE workspace_id=$1", [
    fixture.actor.workspaceId,
  ]);
  assert.equal(events.rows.length, 0, "RLS denies unscoped direct read");
  const audit = await migrationPool.query("BEGIN");
  try {
    await migrationPool.query("SELECT set_config('app.workspace_id',$1,true)", [
      fixture.actor.workspaceId,
    ]);
    const events = await migrationPool.query("SELECT event FROM outbox WHERE workspace_id=$1", [
      fixture.actor.workspaceId,
    ]);
    assert.equal(events.rows.length, 1);
    assert.equal(JSON.stringify(events.rows).includes("PostgreSQL"), false);
  } finally {
    await migrationPool.query("ROLLBACK");
  }
});
test("private saved project chat survives requests but cannot leak across owner/tenant or stale evidence", async () => {
  const fixture = setup();
  const thread = await fixture.service.createThread(fixture.actor, randomUUID(), {
    title: "Customer project",
    scope: { kind: "project", id: randomUUID() },
  });
  const first = await fixture.service.message(fixture.actor, thread.id, randomUUID(), {
    text: "Why PostgreSQL?",
  });
  await fixture.service.work(fixture.actor.workspaceId, first.id);
  assert.equal(
    (await fixture.service.messages(fixture.actor, thread.id)).messages[0]!.status,
    "complete",
  );
  assert.equal((await fixture.service.threads(fixture.actor)).length, 1);
  await assert.rejects(
    fixture.service.messages({ ...fixture.actor, actorId: randomUUID() }, thread.id),
    /NOT_FOUND/,
  );
  await assert.rejects(
    fixture.service.messages({ ...fixture.actor, workspaceId: randomUUID() }, thread.id),
    /NOT_FOUND/,
  );
  fixture.snapshot = {
    ...fixture.snapshot,
    evidence: fixture.snapshot.evidence.map((row) => ({
      ...row,
      revision: 3,
      text: "Owner corrected: not PostgreSQL.",
    })),
  };
  const changed = await fixture.service.messages(fixture.actor, thread.id);
  assert.equal(changed.messages[0]!.status, "invalidated");
  assert.equal(changed.messages[0]!.result, null);
});
test("source permission revocation during model execution and logout before dispatch prevent publication", async () => {
  const fixture = setup();
  const first = await fixture.service.summary(fixture.actor, randomUUID(), {
    meetingId: fixture.meetingId,
  });
  fixture.handler = async () => {
    fixture.allowed = false;
    return { claims: [], unsupported: true };
  };
  await fixture.service.work(fixture.actor.workspaceId, first.id);
  const stored = await repository.scoped(fixture.actor.workspaceId, (tx) => tx.job(first.id));
  assert.equal(stored!.status, "failed");
  assert.equal(stored!.result, null);
  await assert.rejects(fixture.service.job(fixture.actor, first.id), /NOT_FOUND/);
  const second = setup();
  const queued = await second.service.summary(second.actor, randomUUID(), {
    meetingId: second.meetingId,
  });
  second.active = false;
  await second.service.work(second.actor.workspaceId, queued.id);
  assert.equal(second.calls, 0);
  assert.equal(
    (await repository.scoped(second.actor.workspaceId, (tx) => tx.job(queued.id)))!.status,
    "failed",
  );
});
test("partial coverage is explicit, malicious fabricated claims fail and empty evidence is not invented", async () => {
  const fixture = setup();
  fixture.snapshot = {
    ...fixture.snapshot,
    versions: fixture.snapshot.versions.map((row) => ({ ...row, coverage: "partial" })),
  };
  const partial = await fixture.service.summary(fixture.actor, randomUUID(), {
    meetingId: fixture.meetingId,
  });
  await fixture.service.work(fixture.actor.workspaceId, partial.id);
  assert.equal((await fixture.service.job(fixture.actor, partial.id)).result!.partial, true);
  fixture.handler = async () => ({
    claims: [
      {
        kind: "decision",
        text: "We committed $1 million",
        citation: {
          meetingId: fixture.meetingId,
          captureId: fixture.snapshot.evidence[0]!.captureId,
          segmentId: fixture.snapshot.evidence[0]!.segmentId,
          revision: 2,
        },
      },
    ],
    unsupported: false,
  });
  const bad = await fixture.service.summary(fixture.actor, randomUUID(), {
    meetingId: fixture.meetingId,
  });
  await fixture.service.work(fixture.actor.workspaceId, bad.id);
  assert.equal((await fixture.service.job(fixture.actor, bad.id)).errorCode, "UNSUPPORTED_CLAIM");
  fixture.snapshot = { versions: [], evidence: [] };
  const empty = await fixture.service.summary(fixture.actor, randomUUID(), {
    meetingId: fixture.meetingId,
  });
  await fixture.service.work(fixture.actor.workspaceId, empty.id);
  assert.equal((await fixture.service.job(fixture.actor, empty.id)).result!.unsupported, true);
});
test("worker leases fence crashed attempts and reject stale completion", async () => {
  const fixture = setup();
  const queued = await fixture.service.summary(fixture.actor, randomUUID(), {
    meetingId: fixture.meetingId,
  });
  const claimed = await repository.scoped(fixture.actor.workspaceId, (tx) => tx.claim(queued.id));
  assert(claimed);
  assert.equal(
    await repository.scoped(fixture.actor.workspaceId, (tx) => tx.claim(queued.id)),
    null,
  );
  await migrationPool.query("BEGIN");
  try {
    await migrationPool.query("SELECT set_config('app.workspace_id',$1,true)", [
      fixture.actor.workspaceId,
    ]);
    await migrationPool.query(
      "UPDATE intelligence_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [queued.id],
    );
  } finally {
    await migrationPool.query("COMMIT");
  }
  const replacement = await repository.scoped(fixture.actor.workspaceId, (tx) =>
    tx.claim(queued.id),
  );
  assert(replacement);
  assert.notEqual(replacement.leaseToken, claimed.leaseToken);
  const result = {
    claims: [],
    unsupported: true,
    partial: false,
    reviewRequired: true as const,
    sourceFingerprint: fingerprint(fixture.snapshot),
    sourceVersions: fixture.snapshot.versions,
  };
  assert.equal(
    await repository.scoped(fixture.actor.workspaceId, (tx) =>
      tx.complete(queued.id, claimed.leaseToken!, result, []),
    ),
    false,
  );
  await repository.scoped(fixture.actor.workspaceId, (tx) =>
    tx.fail(queued.id, replacement.leaseToken!, "CONTROLLED_STOP", false),
  );
});
test("deletion purges index, commands and affected chats, fences in-flight models and binds immutable targets", async () => {
  const fixture = setup();
  const thread = await fixture.service.createThread(fixture.actor, randomUUID(), {
    title: "Private",
    scope: { kind: "project", id: randomUUID() },
  });
  const completed = await fixture.service.message(fixture.actor, thread.id, randomUUID(), {
    text: "Explain PostgreSQL",
  });
  await fixture.service.work(fixture.actor.workspaceId, completed.id);
  const pending = await fixture.service.message(fixture.actor, thread.id, randomUUID(), {
    text: "What next?",
  });
  const deletionId = randomUUID();
  fixture.handler = async () => {
    await fixture.service.purgeMeeting(fixture.actor.workspaceId, fixture.meetingId, deletionId, 1);
    return { claims: [], unsupported: true };
  };
  await fixture.service.work(fixture.actor.workspaceId, pending.id);
  assert.equal(
    await repository.scoped(fixture.actor.workspaceId, (tx) => tx.job(completed.id)),
    null,
  );
  assert.equal(
    await repository.scoped(fixture.actor.workspaceId, (tx) => tx.job(pending.id)),
    null,
  );
  await fixture.service.purgeMeeting(fixture.actor.workspaceId, fixture.meetingId, deletionId, 1);
  await assert.rejects(
    fixture.service.purgeMeeting(fixture.actor.workspaceId, randomUUID(), deletionId, 1),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    fixture.service.summary(fixture.actor, randomUUID(), { meetingId: fixture.meetingId }),
    /NOT_FOUND/,
  );
});
test("HTTP commands require tenant-bound user authority and idempotency keys; cleanup is separate", async () => {
  const fixture = setup();
  const operationGrantId = randomUUID();
  const app = intelligenceApp(
    fixture.service,
    async (token) =>
      token === "operation"
        ? { ...fixture.actor, operationGrantId, sessionId: `operation:${operationGrantId}` }
        : fixture.actor,
    async () => fixture.actor,
  );
  try {
    const path = `/api/v3/workspaces/${fixture.actor.workspaceId}/intelligence/summaries`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: "Bearer owner" },
          payload: { meetingId: fixture.meetingId },
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
          payload: { meetingId: fixture.meetingId },
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
          payload: { meetingId: fixture.meetingId },
        })
      ).statusCode,
      202,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v3/workspaces/${randomUUID()}/intelligence/chats`,
          headers: { authorization: "Bearer owner" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/internal/workspaces/${fixture.actor.workspaceId}/deletions/${randomUUID()}`,
          headers: { authorization: "Bearer cleanup" },
          payload: { meetingId: fixture.meetingId, sourceVersion: 1 },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});
