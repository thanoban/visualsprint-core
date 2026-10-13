import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  AppError,
  type Actor,
} from "@visualsprint/platform";
import { PostgresCalendars } from "../../src/infrastructure/store.js";
import { CalendarService } from "../../src/application/calendars.js";
import { AesTokenVault } from "../../src/infrastructure/vault.js";
import type { CalendarProvider } from "../../src/application/ports.js";
import type { Occurrence } from "../../src/domain/occurrences.js";
const migration = databasePool(
    "postgres://vs_integration_migration:local-migration-only@127.0.0.1:55437/integration",
    1,
  ),
  pool = databasePool(
    "postgres://vs_integration_runtime:local-runtime-only@127.0.0.1:55437/integration",
    4,
  ),
  repository = new PostgresCalendars(pool);
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
async function fixture() {
  const actor: Actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    sessionId: randomUUID(),
  };
  let now = new Date(),
    connectionId = "",
    active = true,
    changed = true,
    changeCursor = "cursor-1",
    snapshotCalls = 0,
    changeCalls = 0,
    fail = false,
    expired = false,
    unavailable = false;
  const item: Occurrence = {
    sourceKey: randomBytes(32).toString("hex"),
    providerEventId: "event-1",
    title: "Private meeting",
    status: "confirmed",
    startsAt: new Date(now.getTime() + 600000).toISOString(),
    endsAt: new Date(now.getTime() + 3600000).toISOString(),
    allDay: false,
    declined: false,
    joinUrl: "https://meet.google.com/abc-defg-hij",
  };
  let events = [item];
  let snapshot: CalendarProvider["occurrences"] = async () => ({ items: events, nextCursor: null });
  const cursors: (string | undefined)[] = [];
  const provider: CalendarProvider = {
    authorizationUrl: (state) => "https://accounts.google.com/?state=" + state,
    async exchange() {
      return {
        accessToken: "private",
        refreshToken: "private-refresh",
        expiresAt: new Date(now.getTime() + 86400000),
      };
    },
    async refresh() {
      return {
        accessToken: "new",
        refreshToken: "new-refresh",
        expiresAt: new Date(now.getTime() + 86400000),
      };
    },
    async calendars() {
      return { items: [], nextCursor: null };
    },
    async resolveCalendar() {
      return { id: "calendar", name: "Calendar", primary: true };
    },
    async occurrences(...args) {
      snapshotCalls++;
      if (fail) throw new AppError("CALENDAR_PROVIDER_UNAVAILABLE", 503);
      return snapshot(...args);
    },
    async changes(_token, _calendar, _window, sourceCursor) {
      if (unavailable) throw new AppError("CALENDAR_UNAVAILABLE", 403);
      changeCalls++;
      cursors.push(sourceCursor);
      if (expired) {
        expired = false;
        throw new AppError("CALENDAR_SYNC_EXPIRED", 409);
      }
      return { changed, nextCursor: null, finalCursor: changeCursor };
    },
  };
  const service = new CalendarService(
    repository,
    {
      async requireActive() {
        if (!active) throw new AppError("FORBIDDEN", 403);
      },
      async operation() {
        if (!active) throw new AppError("FORBIDDEN", 403);
        return { connectionId };
      },
      async disableGrant() {},
    },
    { google: provider },
    new AesTokenVault("test", { test: randomBytes(32).toString("base64") }),
    () => now,
  );
  const started = await service.start(actor, randomUUID(), { provider: "google" });
  connectionId = started.connection.id;
  const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
  await service.finish(actor, { connectionId, state, code: "code" });
  const connected = await service.initialize(actor, connectionId);
  await service.automation(actor, connectionId, randomUUID(), {
    enabled: true,
    grantId: randomUUID(),
    consent: true,
    expectedVersion: connected.version,
  });
  return {
    actor,
    connectionId,
    item,
    service,
    cursors,
    get snapshotCalls() {
      return snapshotCalls;
    },
    get changeCalls() {
      return changeCalls;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    set changed(value: boolean) {
      changed = value;
    },
    set cursor(value: string) {
      changeCursor = value;
    },
    set events(value: Occurrence[]) {
      events = value;
    },
    set fail(value: boolean) {
      fail = value;
    },
    set expired(value: boolean) {
      expired = value;
    },
    set unavailable(value: boolean) {
      unavailable = value;
    },
    set active(value: boolean) {
      active = value;
    },
    set snapshot(value: CalendarProvider["occurrences"]) {
      snapshot = value;
    },
    async work() {
      await service.work(actor.workspaceId, connectionId);
    },
    async complete() {
      for (let i = 0; i < 6; i++) {
        await service.work(actor.workspaceId, connectionId);
        const state = await repository.scoped(actor.workspaceId, (tx) =>
          tx.latestSync(connectionId),
        );
        if (state?.state === "complete") return;
      }
      throw new Error("SYNC_NOT_COMPLETE");
    },
    async stored() {
      return service.storedOccurrences(actor, connectionId);
    },
    async checkpoint() {
      return scoped(
        actor.workspaceId,
        async (db) =>
          (
            await db.query("SELECT * FROM calendar_sync_checkpoints WHERE connection_id=$1", [
              connectionId,
            ])
          ).rows[0],
      );
    },
  };
}
test("unchanged incremental rounds keep complete visible generation and avoid full reads; hourly reconciliation rolls the window", async () => {
  const f = await fixture();
  await f.complete();
  assert.equal(f.snapshotCalls, 1);
  assert.equal((await f.stored()).items.length, 1);
  const first = await f.checkpoint();
  f.advance(300001);
  f.changed = false;
  f.cursor = "cursor-2";
  await f.complete();
  assert.equal(f.snapshotCalls, 1);
  assert.equal(f.cursors.at(-1), "cursor-1");
  const checkpoint = await f.checkpoint();
  assert.equal(checkpoint.source_cursor, "cursor-2");
  assert.equal(new Date(checkpoint.last_full_at).getTime(), new Date(first.last_full_at).getTime());
  assert.equal((await f.stored()).items.length, 1);
  f.advance(3600001);
  await f.complete();
  assert.equal(f.snapshotCalls, 2);
  assert.equal(f.cursors.at(-1), undefined);
});
test("changed pages cannot advance checkpoint/visibility until authoritative snapshot commits; missing events publish cancellation", async () => {
  const f = await fixture();
  await f.complete();
  f.advance(300001);
  f.cursor = "changed-cursor";
  f.events = [];
  f.fail = true;
  await f.work();
  await assert.rejects(f.work(), /CALENDAR_PROVIDER_UNAVAILABLE/);
  assert.equal((await f.checkpoint()).source_cursor, "cursor-1");
  assert.equal((await f.stored()).items.length, 1);
  f.fail = false;
  await f.complete();
  assert.equal((await f.checkpoint()).source_cursor, "changed-cursor");
  const rows = (await f.stored()).items as Occurrence[];
  assert.equal(rows[0]!.status, "cancelled");
  assert.equal(rows[0]!.joinUrl, null);
});
test("expired change token resets tracking only after a full snapshot, preserving complete state during recovery", async () => {
  const f = await fixture();
  await f.complete();
  f.advance(300001);
  f.expired = true;
  await f.work();
  assert.equal((await f.checkpoint()).source_cursor, "cursor-1");
  assert.equal((await f.stored()).items.length, 1);
  await f.complete();
  assert.equal((await f.checkpoint()).source_cursor, null);
  assert.equal((await f.stored()).items.length, 1);
});
test("known lost calendar permission disables automation instead of scheduling captures from stale completed data", async () => {
  const f = await fixture();
  await f.complete();
  f.advance(300001);
  f.unavailable = true;
  await f.work();
  const connection = await repository.scoped(f.actor.workspaceId, (tx) => tx.get(f.connectionId));
  assert.equal(connection!.automatic, false);
  assert.equal(connection!.status, "configuration_error");
  assert.equal(connection!.errorCode, "CALENDAR_UNAVAILABLE");
  const job = await repository.scoped(f.actor.workspaceId, (tx) => tx.latestSync(f.connectionId));
  assert.equal(job!.state, "blocked");
});
test("deleted source cannot re-enter staged/visible content through late initial insert; permission loss fences publication", async () => {
  const f = await fixture();
  await f.complete();
  await scoped(f.actor.workspaceId, (db) =>
    db.query(
      "INSERT INTO calendar_suppressed_occurrences(workspace_id,connection_id,calendar_id,source_key) VALUES($1,$2,$3,$4)",
      [f.actor.workspaceId, f.connectionId, "calendar", f.item.sourceKey],
    ),
  );
  f.advance(300001);
  f.snapshot = async (_token, _calendar, _window, cursor) =>
    cursor ? { items: [], nextCursor: null } : { items: [f.item], nextCursor: "next" };
  await f.work();
  await f.work();
  const staged = await scoped(
    f.actor.workspaceId,
    async (db) =>
      (
        await db.query(
          "SELECT 1 FROM calendar_sync_stage s JOIN calendar_syncs j ON j.workspace_id=s.workspace_id AND j.id=s.sync_id WHERE j.connection_id=$1",
          [f.connectionId],
        )
      ).rowCount,
  );
  assert.equal(staged, 0);
  await f.complete();
  assert.equal((await f.stored()).items.length, 0);
  const g = await fixture();
  await g.work();
  g.active = false;
  await g.work();
  const job = await repository.scoped(g.actor.workspaceId, (tx) => tx.latestSync(g.connectionId));
  assert.ok(["blocked", "superseded"].includes(job!.state));
});
