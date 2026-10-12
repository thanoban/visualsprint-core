import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  AppError,
  type Actor,
} from "@visualsprint/platform";
import { PostgresCalendars } from "../../src/infrastructure/store.js";
import { AesTokenVault } from "../../src/infrastructure/vault.js";
import { CalendarService } from "../../src/application/calendars.js";
import type { CalendarProvider } from "../../src/application/ports.js";
const migration = databasePool(
    "postgres://vs_integration_migration:local-migration-only@127.0.0.1:55437/integration",
    1,
  ),
  pool = databasePool(
    "postgres://vs_integration_runtime:local-runtime-only@127.0.0.1:55437/integration",
    3,
  );
const repository = new PostgresCalendars(pool),
  vault = new AesTokenVault("test", { test: randomBytes(32).toString("base64") });
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
function fixture(unknown = false) {
  const actor: Actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "session" };
  let calls = 0,
    refreshes = 0,
    active = true,
    clock = new Date("2026-10-12T10:00:00Z");
  const provider: CalendarProvider = {
    authorizationUrl: (state, challenge) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}`,
    async exchange() {
      calls++;
      if (unknown) throw new AppError("OAUTH_RESPONSE_UNKNOWN", 503);
      return {
        accessToken: "private-access",
        refreshToken: "private-refresh",
        expiresAt: new Date(clock.getTime() + 3600000),
      };
    },
    async refresh() {
      refreshes++;
      return {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date(clock.getTime() + 3600000),
      };
    },
    async calendars() {
      return {
        items: [{ id: "private-calendar", name: "Team calendar", primary: true }],
        nextCursor: null,
      };
    },
    async resolveCalendar(_token, id) {
      return {
        id: id === "primary" ? "private-calendar" : id,
        name: "Team calendar",
        primary: id === "primary",
      };
    },
  };
  const service = new CalendarService(
    repository,
    {
      async requireActive() {
        if (!active) throw new AppError("FORBIDDEN", 403);
      },
      async operation() {
        return { connectionId: randomUUID() };
      },
      async disableGrant() {},
    },
    { google: provider },
    vault,
    () => clock,
  );
  const start = () => service.start(actor, "start-test-key", { provider: "google" });
  return {
    actor,
    service,
    start,
    counters: () => ({ calls, refreshes }),
    revoke: () => {
      active = false;
    },
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
test("PKCE start retries keep one connection; actor, session and tenant isolate completion", async () => {
  const f = fixture();
  const first = await f.start();
  assert.deepEqual(await f.start(), first);
  const state = new URL(first.authorizationUrl!).searchParams.get("state")!;
  assert.equal(
    await repository.scoped(randomUUID(), (tx) => tx.get(first.connection.id)),
    undefined,
  );
  await assert.rejects(
    f.service.finish(
      { ...f.actor, actorId: randomUUID() },
      { connectionId: first.connection.id, state, code: "code" },
    ),
    /NOT_FOUND/,
  );
  await assert.rejects(
    f.service.finish(
      { ...f.actor, sessionId: "other-session" },
      { connectionId: first.connection.id, state, code: "code" },
    ),
    /INVALID_OAUTH_STATE/,
  );
  await assert.rejects(
    f.service.finish(f.actor, {
      connectionId: first.connection.id,
      state: "x".repeat(43),
      code: "code",
    }),
    /INVALID_OAUTH_STATE/,
  );
  assert.equal(f.counters().calls, 0);
  const result = await f.service.finish(f.actor, {
    connectionId: first.connection.id,
    state,
    code: "code",
  });
  assert.equal(result.status, "initializing");
  await f.service.finish(f.actor, { connectionId: first.connection.id, state, code: "code" });
  assert.equal(f.counters().calls, 1);
  await f.service.work(f.actor.workspaceId, first.connection.id);
  assert.equal((await f.service.list(f.actor))[0]?.status, "connected");
  const record = (await repository.scoped(f.actor.workspaceId, (tx) =>
    tx.get(first.connection.id),
  ))!;
  assert.equal(record.oauthCipher, null);
  assert.equal(record.tokenCipher?.includes("private-refresh"), false);
  assert.equal(JSON.stringify(result).includes("private-access"), false);
});
test("unknown code-exchange result never silently retries redemption", async () => {
  const f = fixture(true);
  const started = await f.start();
  const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
  const input = { connectionId: started.connection.id, state, code: "code" };
  await assert.rejects(f.service.finish(f.actor, input), /OAUTH_RESPONSE_UNKNOWN/);
  await assert.rejects(f.service.finish(f.actor, input), /OAUTH_EXCHANGE_UNKNOWN/);
  assert.equal(f.counters().calls, 1);
  assert.equal((await f.service.list(f.actor))[0]?.status, "exchange_unknown");
});
test("refresh rotation persists without conflicting with a user configuration version; disconnect removes secrets", async () => {
  const f = fixture();
  const started = await f.start();
  const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
  await f.service.finish(f.actor, { connectionId: started.connection.id, state, code: "code" });
  await f.service.initialize(f.actor, started.connection.id);
  const version = (await f.service.list(f.actor))[0]!.version;
  f.advance(3600000);
  assert.equal((await f.service.calendars(f.actor, started.connection.id)).items.length, 1);
  assert.equal(f.counters().refreshes, 1);
  assert.equal((await f.service.list(f.actor))[0]?.version, version);
  const changed = await f.service.select(f.actor, started.connection.id, "select-test-key", {
    calendarId: "customer-calendar",
    expectedVersion: version,
  });
  assert.equal(changed.calendarId, "customer-calendar");
  const disconnected = await f.service.disconnect(
    f.actor,
    started.connection.id,
    "disconnect-test-key",
    { expectedVersion: changed.version },
  );
  assert.equal(disconnected.status, "disconnected");
  const row = (await repository.scoped(f.actor.workspaceId, (tx) =>
    tx.get(started.connection.id),
  ))!;
  assert.equal(row.tokenCipher, null);
  assert.equal(row.oauthCipher, null);
  await assert.rejects(
    f.service.calendars(f.actor, started.connection.id),
    /CONNECTION_UNAVAILABLE/,
  );
});
test("expired OAuth state and revoked current membership fail closed", async () => {
  const f = fixture();
  const started = await f.start();
  const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
  f.advance(601000);
  await assert.rejects(
    f.service.finish(f.actor, { connectionId: started.connection.id, state, code: "code" }),
    /OAUTH_STATE_EXPIRED/,
  );
  f.revoke();
  await assert.rejects(f.service.list(f.actor), /FORBIDDEN/);
  assert.equal(f.counters().calls, 0);
});
