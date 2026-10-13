import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { databasePool, migrate, assertRuntimeRole } from "@visualsprint/platform";
import { PostgresCalendars } from "../../src/infrastructure/store.js";
import { PostgresCalendarPush } from "../../src/infrastructure/calendar-push-store.js";
import type { Connection } from "../../src/domain/records.js";
const migration = databasePool(
    "postgres://vs_integration_migration:local-migration-only@127.0.0.1:55437/integration",
    1,
  ),
  pool = databasePool(
    "postgres://vs_integration_runtime:local-runtime-only@127.0.0.1:55437/integration",
    4,
  ),
  calendars = new PostgresCalendars(pool),
  push = new PostgresCalendarPush(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function scoped<T>(ws: string, work: (db: import("pg").PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.workspace_id',$1,true)", [ws]);
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
async function fixture(provider: Connection["provider"] = "google") {
  const now = new Date(),
    proof = randomBytes(32).toString("base64url");
  const connection: Connection = {
    workspaceId: randomUUID(),
    id: randomUUID(),
    ownerId: randomUUID(),
    sessionId: "fixture",
    provider,
    status: "connected",
    calendarId: "calendar",
    calendarName: "Calendar",
    version: 1,
    oauthHash: "a".repeat(64),
    oauthCipher: null,
    oauthExpiresAt: new Date(now.getTime() + 3600000),
    tokenCipher: "encrypted-token",
    tokenExpiresAt: new Date(now.getTime() + 86400000),
    exchangeAt: null,
    errorCode: null,
    grantId: randomUUID(),
    automatic: true,
    leaseToken: randomUUID(),
    leaseUntil: new Date(now.getTime() + 30000),
    createdAt: now,
  };
  await calendars.scoped(connection.workspaceId, (tx) => tx.create(connection));
  const input = () => ({
    id: randomUUID(),
    proofHash: createHash("sha256").update(proof).digest("hex"),
    proofCipher: "cipher",
    requestedExpiresAt: new Date(now.getTime() + 86400000),
  });
  return {
    connection,
    now,
    proof,
    input,
    async signal() {
      return scoped(connection.workspaceId, async (db) =>
        Number(
          (
            await db.query("SELECT revision FROM calendar_sync_signals WHERE connection_id=$1", [
              connection.id,
            ])
          ).rows[0]?.revision ?? 0,
        ),
      );
    },
    async rows() {
      return scoped(
        connection.workspaceId,
        async (db) =>
          (
            await db.query(
              "SELECT * FROM calendar_push_subscriptions WHERE connection_id=$1 ORDER BY created_at,id",
              [connection.id],
            )
          ).rows,
      );
    },
  };
}
test("concurrent watch planning creates one durable intent; ambiguous creation cannot repeat before deadline", async () => {
  const f = await fixture();
  const plans = await Promise.all(
    Array.from({ length: 5 }, () => push.plan(f.connection, f.now, f.input())),
  );
  assert.equal(plans.filter(Boolean).length, 1);
  const attempt = plans.find(Boolean)!;
  await push.finish(attempt, { state: "unknown" });
  assert.equal(await push.plan(f.connection, f.now, f.input()), null);
  assert.equal((await f.rows()).length, 1);
  assert.equal((await f.rows())[0]!.state, "unknown");
  await assert.rejects(
    push.finish(attempt, {
      state: "active",
      externalId: attempt.id,
      resourceId: "resource",
      expiresAt: attempt.requestedExpiresAt,
    }),
    /PUSH_FENCED/,
  );
});
test("only bound token/resource hints wake sync; duplicate/reordered message numbers and tenant routing never establish authority", async () => {
  const f = await fixture(),
    attempt = (await push.plan(f.connection, f.now, f.input()))!;
  await push.finish(attempt, {
    state: "active",
    externalId: attempt.id,
    resourceId: "resource",
    expiresAt: attempt.requestedExpiresAt,
  });
  const headers = {
    "x-goog-channel-id": attempt.id,
    "x-goog-channel-token": f.proof,
    "x-goog-resource-id": "resource",
    "x-goog-resource-state": "exists",
    "x-goog-message-number": "5",
  };
  await push.google({ ...headers, "x-goog-channel-token": "wrong".repeat(9) });
  await push.google({ ...headers, "x-goog-resource-id": "foreign" });
  assert.equal(await f.signal(), 0);
  await Promise.all([push.google(headers), push.google(headers)]);
  assert.equal(await f.signal(), 1);
  await push.google({ ...headers, "x-goog-message-number": "2" });
  assert.equal(await f.signal(), 2);
  assert.equal(
    await calendars.scoped(f.connection.workspaceId, (tx) => tx.syncRequested(f.connection.id)),
    true,
  );
  assert.equal(
    (await pool.query("SELECT * FROM calendar_push_subscriptions WHERE id=$1", [attempt.id]))
      .rowCount,
    0,
  );
  await calendars.scoped(f.connection.workspaceId, (tx) =>
    tx.update(f.connection.id, { automatic: false }),
  );
  await push.google({ ...headers, "x-goog-message-number": "6" });
  assert.equal(await f.signal(), 2);
  await push.retire({ ...f.connection, automatic: false });
  const rows = await f.rows();
  assert.equal(rows[0]!.state, "retired");
  assert.equal(rows[0]!.proof_cipher, null);
  assert.equal(
    (await pool.query("SELECT 1 FROM calendar_push_route_index WHERE route_id=$1", [attempt.id]))
      .rowCount,
    0,
  );
});
test("Google early sync hint is authenticated before receipt; disconnect fences late confirmation and purges local proof", async () => {
  const f = await fixture(),
    attempt = (await push.plan(f.connection, f.now, f.input()))!;
  await push.google({
    "x-goog-channel-id": attempt.id,
    "x-goog-channel-token": f.proof,
    "x-goog-resource-id": "resource",
    "x-goog-resource-state": "sync",
    "x-goog-message-number": "1",
  });
  assert.equal(await f.signal(), 1);
  await calendars.scoped(f.connection.workspaceId, (tx) =>
    tx.update(f.connection.id, { status: "disconnected", automatic: false, tokenCipher: null }),
  );
  await push.finish(attempt, {
    state: "active",
    externalId: attempt.id,
    resourceId: "resource",
    expiresAt: attempt.requestedExpiresAt,
  });
  const row = (await f.rows())[0]!;
  assert.equal(row.state, "retired");
  assert.equal(row.proof_cipher, null);
  assert.equal(row.external_id, attempt.id);
});
test("Graph known-ID renewal uses one record, lifecycle hints request reconciliation and bad clientState is ignored", async () => {
  const externalId = randomUUID();
  const f = await fixture("microsoft"),
    first = (await push.plan(f.connection, f.now, f.input()))!;
  await push.finish(first, {
    state: "active",
    externalId,
    resourceId: null,
    expiresAt: first.requestedExpiresAt,
  });
  await push.microsoft({
    value: [
      {
        subscriptionId: externalId,
        clientState: "wrong".repeat(9),
        changeType: "updated",
      },
    ],
  });
  assert.equal(await f.signal(), 0);
  await push.microsoft({
    value: [
      {
        subscriptionId: externalId,
        clientState: f.proof,
        lifecycleEvent: "reauthorizationRequired",
      },
    ],
  });
  assert.equal(await f.signal(), 1);
  const renewed = (await push.plan(f.connection, f.now, f.input()))!;
  assert.equal(renewed.id, first.id);
  assert.equal(renewed.action, "renew");
  assert.equal(renewed.externalId, externalId);
  await push.finish(renewed, { state: "unknown" });
  const reconcile = (await push.plan(f.connection, f.now, f.input()))!;
  assert.equal(reconcile.action, "reconcile");
  assert.equal(reconcile.externalId, externalId);
  assert.equal((await f.rows()).length, 1);
});
