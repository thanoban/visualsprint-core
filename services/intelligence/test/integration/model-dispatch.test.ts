import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { databasePool, migrate, assertRuntimeRole } from "@visualsprint/platform";
import { PostgresModelDispatch } from "../../src/infrastructure/model-dispatch.js";
const migration = databasePool(
  process.env.INTELLIGENCE_TEST_MIGRATION_URL ??
    "postgres://vs_intelligence_migration:local-migration-only@127.0.0.1:55438/intelligence",
  1,
);
const pool = databasePool(
  process.env.INTELLIGENCE_TEST_DATABASE_URL ??
    "postgres://vs_intelligence_runtime:local-runtime-only@127.0.0.1:55438/intelligence",
  3,
);
const ledger = new PostgresModelDispatch(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
test("owning dispatch ledger commits one fenced intent, supports logout cleanup, and enforces tenant RLS", async () => {
  const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "owner" },
    operation = randomUUID(),
    reservation = randomUUID();
  const concurrent = await Promise.allSettled([
    ledger.intent(actor, operation, reservation),
    ledger.intent(actor, operation, reservation),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  await assert.rejects(ledger.intent(actor, operation, randomUUID()), /MODEL_DISPATCH_REPLAY/);
  await ledger.record({ ...actor, sessionId: "revoked-owner-session" }, reservation, "unknown");
  await ledger.record(actor, reservation, "unknown");
  await assert.rejects(
    ledger.record(actor, reservation, "not_started"),
    /MODEL_DISPATCH_RECORD_CONFLICT/,
  );
  await assert.rejects(
    ledger.record({ ...actor, actorId: randomUUID() }, reservation, "unknown"),
    /MODEL_DISPATCH_RECORD_CONFLICT/,
  );
  await assert.rejects(
    ledger.record({ ...actor, workspaceId: randomUUID() }, reservation, "unknown"),
    /MODEL_DISPATCH_RECORD_CONFLICT/,
  );
  assert.equal((await pool.query("SELECT * FROM model_dispatches")).rows.length, 0);
});
