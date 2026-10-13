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
import { PostgresExports } from "../../src/infrastructure/store.js";
import { ReportingService } from "../../src/application/reporting.js";
import { reportingApp } from "../../src/http/app.js";
import type { Evidence } from "../../src/domain/export.js";
const migration = databasePool(
    "postgres://vs_reporting_migration:local-migration-only@127.0.0.1:55439/reporting",
    1,
  ),
  pool = databasePool(
    "postgres://vs_reporting_runtime:local-runtime-only@127.0.0.1:55439/reporting",
    3,
  ),
  repository = new PostgresExports(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
function fixture() {
  const actor: Actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    sessionId: "controlled-session",
  };
  let active = true,
    revision = 1,
    clock = new Date();
  const meetingId = randomUUID();
  const source = {
    async authorize() {
      if (!active) throw new AppError("FORBIDDEN", 403);
    },
    async load() {
      await this.authorize();
      return {
        meetingId,
        version: revision,
        title: "Test customer",
        notes: "Private notes",
        captures: [],
      } satisfies Evidence;
    },
  };
  return {
    actor,
    meetingId,
    service: new ReportingService(repository, source, () => clock),
    source,
    revoke: () => {
      active = false;
    },
    revise: () => {
      revision++;
    },
    advance: () => {
      clock = new Date(clock.getTime() + 90000000);
    },
    now: () => clock,
  };
}
test("durable request idempotency, authorized attachment and changed revision fail closed", async () => {
  const f = fixture();
  const job = await f.service.create(f.actor, "export-request-1", { meetingId: f.meetingId });
  assert.equal(
    (await f.service.create(f.actor, "export-request-1", { meetingId: f.meetingId })).id,
    job.id,
  );
  await assert.rejects(
    f.service.create(f.actor, "export-request-1", { meetingId: f.meetingId, format: "json" }),
    (e) => e instanceof AppError && e.status === 409,
  );
  await f.service.work(f.actor.workspaceId, job.id);
  assert.equal((await f.service.status(f.actor, job.id)).state, "complete");
  const app = reportingApp(f.service, async () => f.actor);
  try {
    const response = await app.inject({
      url: `/api/v3/workspaces/${f.actor.workspaceId}/exports/${job.id}/download`,
      headers: { authorization: "Bearer fixture" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(String(response.headers["content-disposition"]), /attachment/);
  } finally {
    await app.close();
  }
  f.revise();
  await assert.rejects(
    f.service.download(f.actor, job.id),
    (e) => e instanceof AppError && e.code === "EXPORT_SOURCE_CHANGED",
  );
  f.revoke();
  await assert.rejects(
    f.service.status(f.actor, job.id),
    (e) => e instanceof AppError && e.status === 403,
  );
});
test("revoked generation is blocked; wrong owner/tenant cannot read; expiry purges content", async () => {
  const f = fixture(),
    job = await f.service.create(f.actor, "export-request-2", { meetingId: f.meetingId });
  await assert.rejects(
    f.service.status({ ...f.actor, actorId: randomUUID() }, job.id),
    (e) => e instanceof AppError && e.status === 404,
  );
  assert.equal(await repository.get(randomUUID(), job.id), undefined);
  f.revoke();
  await f.service.work(f.actor.workspaceId, job.id);
  assert.equal((await repository.get(f.actor.workspaceId, job.id))?.state, "blocked");
  const second = fixture(),
    ready = await second.service.create(second.actor, "export-request-3", {
      meetingId: second.meetingId,
    });
  await second.service.work(second.actor.workspaceId, ready.id);
  second.advance();
  await repository.expire(second.now());
  const expired = await repository.get(second.actor.workspaceId, ready.id);
  assert.equal(expired?.state, "expired");
  assert.equal(expired?.content, null);
});
test("deletion atomically purges exports and fences stale workers and new intents", async () => {
  const f = fixture(),
    job = await f.service.create(f.actor, "export-request-4", { meetingId: f.meetingId }),
    claim = await repository.claim(f.actor.workspaceId, job.id, f.now());
  assert.ok(claim);
  const deletionId = randomUUID(),
    body = { meetingId: f.meetingId, sourceVersion: 2 };
  assert.equal((await f.service.delete(f.actor.workspaceId, deletionId, body)).state, "complete");
  await f.service.delete(f.actor.workspaceId, deletionId, body);
  await repository.finish(
    claim,
    { state: "complete", content: "must not resurrect", fingerprint: "stale" },
    f.now(),
  );
  const deleted = await repository.get(f.actor.workspaceId, job.id);
  assert.equal(deleted?.state, "deleted");
  assert.equal(deleted?.content, null);
  await assert.rejects(
    f.service.create(f.actor, "new-export-request", { meetingId: f.meetingId }),
    (e) => e instanceof AppError && e.status === 404,
  );
  await assert.rejects(
    f.service.delete(f.actor.workspaceId, deletionId, { ...body, meetingId: randomUUID() }),
    (e) => e instanceof AppError && e.code === "DELETION_TARGET_CONFLICT",
  );
});
