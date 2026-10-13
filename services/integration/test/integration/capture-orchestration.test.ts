import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { databasePool, migrate, AppError, type Actor } from "@visualsprint/platform";
import { CalendarService } from "../../src/application/calendars.js";
import {
  CalendarCaptureOrchestrator,
  type CalendarCaptureView,
} from "../../src/application/calendar-captures.js";
import { PostgresCalendars } from "../../src/infrastructure/store.js";
import { PostgresCalendarCaptureTasks } from "../../src/infrastructure/capture-tasks.js";
import { AesTokenVault } from "../../src/infrastructure/vault.js";
import type { CalendarProvider, CalendarAuthority } from "../../src/application/ports.js";
const migration = databasePool(
  "postgres://vs_integration_migration:local-migration-only@127.0.0.1:55437/integration",
  1,
);
const pool = databasePool(
  "postgres://vs_integration_runtime:local-runtime-only@127.0.0.1:55437/integration",
  3,
);
before(() => migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url))));
after(async () => {
  await pool.end();
  await migration.end();
});
async function fixture(loseReply = false) {
  const actor: Actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    sessionId: "calendar-capture-owner",
  };
  let clock = new Date(),
    connectionId = "",
    grantActive = true,
    sessionActive = true,
    createCalls = 0,
    stopCalls = 0;
  let occurrence = {
    sourceKey: "distinct-source",
    providerEventId: "event",
    title: "Founder call",
    status: "confirmed" as "confirmed" | "cancelled",
    allDay: false,
    declined: false,
    joinUrl: "https://meet.google.com/abc-defg-hij",
    startsAt: new Date(clock.getTime() + 3600000).toISOString(),
    endsAt: new Date(clock.getTime() + 7200000).toISOString(),
  };
  const captures = new Map<string, CalendarCaptureView>(),
    fenced = new Set<string>();
  const repository = new PostgresCalendars(pool),
    tasks = new PostgresCalendarCaptureTasks(pool);
  const authority: CalendarAuthority = {
    async requireActive(a) {
      if (a.operationGrantId ? !grantActive : !sessionActive) throw new AppError("FORBIDDEN", 403);
    },
    async operation() {
      if (!grantActive) throw new AppError("FORBIDDEN", 403);
      return { connectionId };
    },
    async disableGrant() {
      grantActive = false;
    },
  };
  const meetings = {
      async upsert() {
        return { id: meetingId, version: 1 };
      },
    },
    meetingId = randomUUID();
  const orchestrator = new CalendarCaptureOrchestrator(
    tasks,
    authority,
    meetings,
    {
      async command(_a, key, cancel) {
        if (cancel) {
          stopCalls++;
          fenced.add(key);
          const old = captures.get(key);
          if (old) old.state = "cancelled";
        }
        return captures.get(key) ?? null;
      },
      async request(a, key, input) {
        assert.equal(a.operationGrantId, grantId);
        assert.equal(input.maxDurationSeconds, 14400);
        if (fenced.has(key)) throw new AppError("CALENDAR_CAPTURE_CANCELLED", 409);
        createCalls++;
        const result = { id: randomUUID(), state: "scheduled", stopRequested: false };
        captures.set(key, result);
        if (loseReply) {
          loseReply = false;
          throw new AppError("CALENDAR_CAPTURE_RESPONSE_UNKNOWN", 503);
        }
        return result;
      },
    },
    () => clock,
  );
  const provider: CalendarProvider = {
    authorizationUrl: (state) => `https://accounts.google.com?state=${state}`,
    async exchange() {
      return {
        accessToken: "controlled",
        refreshToken: "controlled",
        expiresAt: new Date(clock.getTime() + 86400000),
      };
    },
    async refresh() {
      throw new Error("UNEXPECTED_REFRESH");
    },
    async calendars() {
      return { items: [], nextCursor: null };
    },
    async resolveCalendar() {
      return { id: "test-calendar", name: "Calendar", primary: true };
    },
    async occurrences() {
      return { items: [occurrence], nextCursor: null };
    },
  };
  const service = new CalendarService(
    repository,
    authority,
    { google: provider },
    new AesTokenVault("test", { test: randomBytes(32).toString("base64") }),
    () => clock,
    meetings,
    orchestrator,
  );
  const started = await service.start(actor, randomUUID(), { provider: "google" });
  connectionId = started.connection.id;
  await service.finish(actor, {
    connectionId,
    state: new URL(started.authorizationUrl!).searchParams.get("state"),
    code: "controlled",
  });
  await service.initialize(actor, connectionId);
  const grantId = randomUUID();
  await service.automation(actor, connectionId, randomUUID(), {
    enabled: true,
    grantId,
    consent: true,
    expectedVersion: (await service.list(actor))[0]!.version,
  });
  async function tick() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [actor.workspaceId]);
      await client.query(
        "UPDATE calendar_capture_tasks SET next_at=now()-interval '1 second' WHERE connection_id=$1",
        [connectionId],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await service.work(actor.workspaceId, connectionId);
  }
  return {
    actor,
    connectionId,
    grantId,
    repository,
    tasks,
    service,
    tick,
    captures,
    meetingId,
    fenced,
    counters: () => ({ createCalls, stopCalls }),
    logout() {
      sessionActive = false;
    },
    revoke() {
      grantActive = false;
    },
    change(value: Partial<typeof occurrence>) {
      occurrence = { ...occurrence, ...value };
      clock = new Date(clock.getTime() + 300001);
    },
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
test("calendar end time and title edits do not stop an active capture; provider end owns finalization", async () => {
  const f = await fixture();
  await f.tick();
  [...f.captures.values()][0]!.state = "capturing";
  f.change({
    title: "Human renamed calendar",
    endsAt: new Date(Date.now() + 10800000).toISOString(),
  });
  await f.tick();
  assert.equal(f.counters().createCalls, 1);
  assert.equal(f.counters().stopCalls, 0);
  f.advance(4 * 3600000);
  await f.tick();
  assert.equal(f.counters().stopCalls, 0);
});
test("calendar deletion suppresses stored source and fences future capture re-creation", async () => {
  const f = await fixture();
  await f.tick();
  const deletionId = randomUUID();
  await f.tasks.purge(f.actor.workspaceId, deletionId, f.meetingId, 1);
  await assert.rejects(
    f.tasks.purge(f.actor.workspaceId, deletionId, randomUUID(), 1),
    /DELETION_CONFLICT/,
  );
  f.change({ title: "Provider title after deletion" });
  await f.tick();
  assert.equal(f.counters().createCalls, 1);
  assert.equal(f.fenced.size, 1);
  const stored = await f.service.storedOccurrences(f.actor, f.connectionId);
  assert.ok(!JSON.stringify(stored).includes("Provider title after deletion"));
});
test("automatic calendar occurrence uses durable capture intent after logout and recovers a lost response without duplicate", async () => {
  const f = await fixture(true);
  f.logout();
  await assert.rejects(f.tick(), /CALENDAR_CAPTURE_RESPONSE_UNKNOWN/);
  assert.equal(f.counters().createCalls, 1);
  await f.tick();
  assert.equal(f.counters().createCalls, 1);
  assert.equal(f.captures.size, 1);
  await assert.rejects(f.service.list(f.actor), /FORBIDDEN/);
});
test("rescheduling fences the prior key before replacement; explicit cancellation stops owned capture", async () => {
  const f = await fixture();
  await f.tick();
  assert.equal(f.counters().createCalls, 1);
  f.change({
    startsAt: new Date(Date.now() + 7200000).toISOString(),
    endsAt: new Date(Date.now() + 10800000).toISOString(),
  });
  await f.tick();
  assert.equal(f.counters().createCalls, 2);
  assert.equal(f.fenced.size, 1);
  f.change({ status: "cancelled" });
  await f.tick();
  assert.equal(f.counters().createCalls, 2);
  assert.equal(f.fenced.size, 2);
  assert.ok([...f.captures.values()].every((c) => c.state === "cancelled"));
});
test("grant revocation cleans up persisted capture even though new authorization fails; other tenants cannot claim", async () => {
  const f = await fixture();
  await f.tick();
  f.revoke();
  await f.tick();
  assert.equal(f.counters().createCalls, 1);
  assert.equal(f.fenced.size, 1);
  assert.equal(await f.tasks.claim(randomUUID(), f.connectionId), null);
});
