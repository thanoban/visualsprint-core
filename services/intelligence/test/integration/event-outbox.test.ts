import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { databasePool, migrate, assertRuntimeRole } from "@visualsprint/platform";
import type { DomainEvent } from "@visualsprint/contracts";
import { IntelligenceEventOutbox } from "../../src/infrastructure/event-outbox.js";
const migration = databasePool(
  process.env.INTELLIGENCE_TEST_MIGRATION_URL ??
    "postgres://vs_intelligence_migration:local-migration-only@127.0.0.1:55438/intelligence",
  1,
);
const pool = databasePool(
  process.env.INTELLIGENCE_TEST_DATABASE_URL ??
    "postgres://vs_intelligence_runtime:local-runtime-only@127.0.0.1:55438/intelligence",
  4,
);
const repository = new IntelligenceEventOutbox(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function scoped<T>(workspaceId: string, work: (db: import("pg").PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
    const result = await work(db);
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
  const workspaceId = randomUUID(),
    rowId = randomUUID();
  const event: DomainEvent = {
    eventId: randomUUID(),
    type: "summary.ready.v1",
    schemaVersion: 1,
    workspaceId,
    aggregateId: randomUUID(),
    aggregateVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: randomUUID().replaceAll("-", ""),
    actorId: randomUUID(),
    references: [{ kind: "meeting", id: randomUUID(), revision: 1 }],
  };
  await scoped(workspaceId, (db) =>
    db.query("INSERT INTO outbox(workspace_id,id,event) VALUES($1,$2,$3)", [
      workspaceId,
      rowId,
      event,
    ]),
  );
  return { workspaceId, rowId, event };
}
test("native publisher routes references, fences concurrent delivery and removes acknowledged work", async () => {
  const f = await fixture(),
    delivered: DomainEvent[] = [];
  const publisher = {
    async publish(event: DomainEvent) {
      delivered.push(event);
    },
  };
  const counts = await Promise.all(
    Array.from({ length: 6 }, () => repository.publish(f.workspaceId, publisher)),
  );
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    1,
  );
  assert.deepEqual(delivered, [f.event]);
  assert.equal(await repository.publish(f.workspaceId, publisher), 0);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM intelligence_event_work_index WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
    0,
  );
  assert.equal((await pool.query("SELECT 1 FROM outbox WHERE id=$1", [f.rowId])).rowCount, 0);
  const forced = await pool.query(
    "SELECT relforcerowsecurity FROM pg_class WHERE oid='outbox'::regclass",
  );
  assert.equal(forced.rows[0].relforcerowsecurity, true);
});
test("unknown broker outcomes remain unpublished; redelivery preserves the exact event ID", async () => {
  const f = await fixture(),
    seen: string[] = [];
  await assert.rejects(
    repository.publish(f.workspaceId, {
      async publish(event) {
        seen.push(event.eventId);
        throw new Error("ACK_UNKNOWN");
      },
    }),
    /ACK_UNKNOWN/,
  );
  const row = await scoped(
    f.workspaceId,
    async (db) =>
      (await db.query("SELECT published_at FROM outbox WHERE id=$1", [f.rowId])).rows[0],
  );
  assert.equal(row.published_at, null);
  assert.equal(
    await repository.publish(f.workspaceId, {
      async publish() {
        throw new Error("EARLY_RETRY");
      },
    }),
    0,
  );
  await scoped(f.workspaceId, (db) =>
    db.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1", [f.rowId]),
  );
  assert.equal(
    await repository.publish(f.workspaceId, {
      async publish(event) {
        seen.push(event.eventId);
      },
    }),
    1,
  );
  assert.deepEqual(seen, [f.event.eventId, f.event.eventId]);
});
test("tenant mismatch fails before broker dispatch and deletion cancels pending routing", async () => {
  const f = await fixture();
  await scoped(f.workspaceId, (db) =>
    db.query(
      "UPDATE outbox SET event=jsonb_set(event,'{workspaceId}',to_jsonb($2::text)) WHERE id=$1",
      [f.rowId, randomUUID()],
    ),
  );
  let calls = 0;
  await assert.rejects(
    repository.publish(f.workspaceId, {
      async publish() {
        calls++;
      },
    }),
    /OUTBOX_TENANT_MISMATCH/,
  );
  assert.equal(calls, 0);
  await scoped(f.workspaceId, (db) => db.query("DELETE FROM outbox WHERE id=$1", [f.rowId]));
  assert.equal(
    (
      await pool.query("SELECT 1 FROM intelligence_event_work_index WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    await repository.publish(f.workspaceId, {
      async publish() {
        calls++;
      },
    }),
    0,
  );
  await assert.rejects(
    repository.publish(f.workspaceId, { async publish() {} }, 0),
    /INVALID_BATCH_LIMIT/,
  );
  await assert.rejects(repository.defer(f.workspaceId, 0), /INVALID_RETRY/);
});

test("a claimed later row is not sent after lease expiry or deletion during earlier delivery", async () => {
  for (const change of ["expire", "delete"] as const) {
    const f = await fixture(),
      secondId = randomUUID();
    const second = { ...f.event, eventId: randomUUID(), aggregateId: randomUUID() };
    await scoped(f.workspaceId, (db) =>
      db.query(
        "INSERT INTO outbox(workspace_id,id,event,created_at) VALUES($1,$2,$3,now()+interval '1 second')",
        [f.workspaceId, secondId, second],
      ),
    );
    const seen: string[] = [];
    const count = await repository.publish(f.workspaceId, {
      async publish(event) {
        seen.push(event.eventId);
        await scoped(f.workspaceId, (db) =>
          change === "expire"
            ? db.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1", [
                secondId,
              ])
            : db.query("DELETE FROM outbox WHERE id=$1", [secondId]),
        );
      },
    });
    assert.equal(count, 1);
    assert.deepEqual(seen, [f.event.eventId]);
    assert.equal(
      await repository.publish(f.workspaceId, {
        async publish(event) {
          seen.push(event.eventId);
        },
      }),
      change === "expire" ? 1 : 0,
    );
    assert.deepEqual(
      seen,
      change === "expire" ? [f.event.eventId, second.eventId] : [f.event.eventId],
    );
  }
});
