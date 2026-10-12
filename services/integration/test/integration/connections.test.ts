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
  let pages: CalendarProvider["occurrences"] = async () => ({ items: [], nextCursor: null });
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
    occurrences: (...args) => pages(...args),
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
    pages: (value: CalendarProvider["occurrences"]) => {
      pages = value;
    },
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
async function connected() {
  const f = fixture(),
    started = await f.start(),
    connectionId = started.connection.id;
  await f.service.finish(f.actor, {
    connectionId,
    state: new URL(started.authorizationUrl!).searchParams.get("state")!,
    code: "code",
  });
  await f.service.initialize(f.actor, connectionId);
  return { ...f, connectionId };
}
const event = {
  sourceKey: "source-a",
  providerEventId: "vendor-a",
  title: "Customer call",
  status: "confirmed" as const,
  startsAt: "2026-10-12T11:00:00Z",
  endsAt: "2026-10-12T12:00:00Z",
  allDay: false,
  declined: false,
  joinUrl: "https://meet.google.com/abc-defg-hij",
};
test("durable sync resumes committed pages, publishes once and preserves the prior complete snapshot", async () => {
  const f = await connected();
  f.pages(async () => ({ items: [event], nextCursor: null }));
  const first = await f.service.synchronize(f.actor, f.connectionId, "sync-first-key");
  assert.deepEqual(await f.service.synchronize(f.actor, f.connectionId, "sync-first-key"), first);
  await f.service.work(f.actor.workspaceId, f.connectionId);
  assert.equal((await f.service.syncStatus(f.actor, f.connectionId))!.state, "complete");
  const original = (await f.service.storedOccurrences(f.actor, f.connectionId)).items as {
    id: string;
    version: number;
    title: string;
  }[];
  assert.equal(original[0]!.version, 1);
  let outage = true;
  f.pages(async (_token, _calendar, _window, cursor) => {
    if (!cursor)
      return { items: [{ ...event, title: "Rescheduled call" }], nextCursor: "next-page" };
    if (outage) throw new AppError("CALENDAR_PROVIDER_UNAVAILABLE", 503);
    return {
      items: [{ ...event, sourceKey: "source-b", providerEventId: "vendor-b" }],
      nextCursor: null,
    };
  });
  await f.service.synchronize(f.actor, f.connectionId, "sync-second-key");
  await f.service.work(f.actor.workspaceId, f.connectionId);
  assert.equal((await f.service.syncStatus(f.actor, f.connectionId))!.pageCount, 1);
  assert.deepEqual((await f.service.storedOccurrences(f.actor, f.connectionId)).items, original);
  await assert.rejects(
    f.service.work(f.actor.workspaceId, f.connectionId),
    /CALENDAR_PROVIDER_UNAVAILABLE/,
  );
  outage = false;
  await f.service.work(f.actor.workspaceId, f.connectionId);
  const updated = (await f.service.storedOccurrences(f.actor, f.connectionId)).items as {
    id: string;
    version: number;
    title: string;
  }[];
  assert.equal(updated.length, 2);
  assert.equal(updated.find((x) => x.id === original[0]!.id)!.version, 2);
  await f.service.work(f.actor.workspaceId, f.connectionId);
  assert.deepEqual((await f.service.storedOccurrences(f.actor, f.connectionId)).items, updated);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
    const events = await client.query(
      "SELECT event FROM outbox WHERE event->>'type'='calendar.occurrence.changed.v1'",
    );
    assert.equal(events.rows.length, 3);
    assert.equal(JSON.stringify(events.rows).includes("Customer call"), false);
    assert.equal(JSON.stringify(events.rows).includes("meet.google.com"), false);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal(
    await repository.scoped(randomUUID(), (tx) => tx.latestSync(f.connectionId)),
    undefined,
  );
});
test("repeating pagination cannot publish partial changes; revocation blocks outstanding work", async () => {
  const f = await connected();
  f.pages(async () => ({ items: [event], nextCursor: "loop" }));
  await f.service.synchronize(f.actor, f.connectionId, "sync-loop-key");
  await f.service.work(f.actor.workspaceId, f.connectionId);
  await f.service.work(f.actor.workspaceId, f.connectionId);
  assert.equal((await f.service.syncStatus(f.actor, f.connectionId))!.state, "failed");
  assert.deepEqual((await f.service.storedOccurrences(f.actor, f.connectionId)).items, []);
  await f.service.synchronize(f.actor, f.connectionId, "sync-revoke-key");
  f.revoke();
  await f.service.work(f.actor.workspaceId, f.connectionId);
  await assert.rejects(f.service.syncStatus(f.actor, f.connectionId), /FORBIDDEN/);
  const job = await repository.scoped(f.actor.workspaceId, (tx) => tx.latestSync(f.connectionId));
  assert.equal(job!.state, "blocked");
});
test("disconnect during a provider page fences publication and clears staged work", async () => {
  const f = await connected();
  f.pages(async () => {
    const version = (await f.service.list(f.actor))[0]!.version;
    await f.service.disconnect(f.actor, f.connectionId, "disconnect-during-sync", {
      expectedVersion: version,
    });
    return { items: [event], nextCursor: null };
  });
  await f.service.synchronize(f.actor, f.connectionId, "sync-disconnect-key");
  await f.service.work(f.actor.workspaceId, f.connectionId);
  assert.equal((await f.service.syncStatus(f.actor, f.connectionId))!.state, "superseded");
  await assert.rejects(
    f.service.storedOccurrences(f.actor, f.connectionId),
    /CONNECTION_UNAVAILABLE/,
  );
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
  const events = await f.service.occurrences(f.actor, started.connection.id, {});
  assert.deepEqual(events.items, []);
  assert.equal(
    Date.parse(events.window.endsAt) - Date.parse(events.window.startsAt),
    14 * 86400000,
  );
  await assert.rejects(
    f.service.occurrences(f.actor, started.connection.id, { cursor: "missing-window" }),
    /INVALID_CALENDAR_WINDOW/,
  );
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
  await assert.rejects(
    f.service.occurrences(f.actor, started.connection.id, {}),
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
