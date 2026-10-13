import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  AppError,
  type Actor,
} from "@visualsprint/platform";
import {
  DeletionService,
  deletionParticipants,
  type DeletionParticipant,
  type DeletionPort,
} from "../../src/application/deletion-service.js";
import { PostgresDeletions } from "../../src/infrastructure/deletion-store.js";
const migration = databasePool(
    "postgres://vs_workspace_migration:local-migration-only@127.0.0.1:55433/workspace",
    1,
  ),
  pool = databasePool(
    "postgres://vs_workspace_runtime:local-runtime-only@127.0.0.1:55433/workspace",
    3,
  ),
  repository = new PostgresDeletions(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function scoped<T>(ws: string, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [ws]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
async function fixture() {
  const actor: Actor = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      sessionId: "fixture-session",
    },
    meetingId = randomUUID();
  let active = true;
  const ports: Partial<Record<DeletionParticipant, DeletionPort>> = {};
  const authority = {
    async active() {
      if (!active) throw new AppError("FORBIDDEN", 403);
    },
    async manage(principal: Actor) {
      if (principal.actorId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
    },
  };
  await scoped(actor.workspaceId, async (c) => {
    await c.query(
      "INSERT INTO meetings(workspace_id,id,owner_id,title,notes,join_url) VALUES($1,$2,$3,'Confidential name','Confidential notes','https://meet.google.com/abc-defg-hij')",
      [actor.workspaceId, meetingId, actor.actorId],
    );
    await c.query(
      "INSERT INTO commands(workspace_id,actor_id,key,fingerprint,response) VALUES($1,$2,'fixture-command','hash',$3)",
      [
        actor.workspaceId,
        actor.actorId,
        JSON.stringify({ id: meetingId, title: "Confidential name", notes: "Confidential notes" }),
      ],
    );
  });
  return {
    actor,
    meetingId,
    ports,
    service: new DeletionService(repository, authority, ports),
    revoke: () => {
      active = false;
    },
  };
}
test("deletion blocks access and erases owning content atomically; replay is stable and owner-private", async () => {
  const f = await fixture();
  await assert.rejects(
    f.service.request({ ...f.actor, actorId: randomUUID() }, "delete-command-1", {
      meetingId: f.meetingId,
      expectedVersion: 1,
    }),
    (e) => e instanceof AppError && e.status === 404,
  );
  const job = await f.service.request(f.actor, "delete-command-1", {
    meetingId: f.meetingId,
    expectedVersion: 1,
  });
  assert.equal(job.state, "pending");
  assert.equal(
    (
      await f.service.request(f.actor, "delete-command-1", {
        meetingId: f.meetingId,
        expectedVersion: 1,
      })
    ).id,
    job.id,
  );
  await assert.rejects(
    f.service.request(f.actor, "delete-command-1", { meetingId: f.meetingId, expectedVersion: 2 }),
    (e) => e instanceof AppError && e.code === "IDEMPOTENCY_CONFLICT",
  );
  const record = await scoped(
    f.actor.workspaceId,
    async (c) => (await c.query("SELECT * FROM meetings WHERE id=$1", [f.meetingId])).rows[0],
  );
  assert.equal(record.blocked, true);
  assert.equal(record.notes, "");
  assert.equal(record.join_url, null);
  const command = await scoped(
    f.actor.workspaceId,
    async (c) =>
      (await c.query("SELECT response FROM commands WHERE key='fixture-command'")).rows[0],
  );
  assert.deepEqual(command.response, { id: f.meetingId, deleted: true });
  assert.equal(await repository.get(randomUUID(), job.id), undefined);
  f.revoke();
  await assert.rejects(
    f.service.status(f.actor, job.id),
    (e) => e instanceof AppError && e.status === 403,
  );
});
test("completion requires every owning acknowledgement; retries retain completed participants after logout", async () => {
  const f = await fixture(),
    calls = new Map<string, number>();
  f.ports.reporting = {
    async remove() {
      calls.set("reporting", (calls.get("reporting") ?? 0) + 1);
      return { state: "complete" };
    },
  };
  const job = await f.service.request(f.actor, "delete-command-2", {
    meetingId: f.meetingId,
    expectedVersion: 1,
  });
  await f.service.work(f.actor.workspaceId, job.id);
  const pending = await repository.get(f.actor.workspaceId, job.id);
  assert.equal(pending?.state, "pending");
  assert.deepEqual(Object.keys(pending!.acknowledgements), ["reporting"]);
  for (const p of deletionParticipants)
    if (p !== "reporting")
      f.ports[p] = {
        async remove() {
          return { state: "complete" };
        },
      };
  f.revoke();
  await f.service.work(f.actor.workspaceId, job.id);
  assert.equal((await repository.get(f.actor.workspaceId, job.id))?.state, "complete");
  assert.equal(calls.get("reporting"), 1);
});
