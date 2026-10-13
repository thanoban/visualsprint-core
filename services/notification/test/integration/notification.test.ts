import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AppError,
  databasePool,
  migrate,
  assertRuntimeRole,
  type Actor,
} from "@visualsprint/platform";
import { eventEnvelope } from "@visualsprint/contracts";
import { PostgresNotifications } from "../../src/infrastructure/store.js";
import { NotificationService } from "../../src/application/notification.js";
import { notificationApp } from "../../src/http/app.js";
import type { EmailResult, EmailLookup } from "../../src/domain/notification.js";
const migrationPool = databasePool(
    process.env.NOTIFICATION_TEST_MIGRATION_URL ??
      "postgres://vs_notification_migration:local-migration-only@127.0.0.1:55441/notification",
    1,
  ),
  pool = databasePool(
    process.env.NOTIFICATION_TEST_DATABASE_URL ??
      "postgres://vs_notification_runtime:local-runtime-only@127.0.0.1:55441/notification",
    4,
  );
const repository = new PostgresNotifications(pool);
before(async () => {
  await migrate(migrationPool, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migrationPool.end();
});
function fixture() {
  const actor: Actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    sessionId: randomUUID(),
  };
  const meetingId = randomUUID();
  let allowed = true,
    member = true,
    session = true,
    configured = true,
    verifiedEmail: string | null = "verified-user@example.test";
  let result: EmailResult = { state: "sent", externalId: "email-1" },
    lookup: EmailLookup = { state: "pending" };
  const sends: { deliveryId: string; to: string; subject: string; text: string }[] = [];
  let lookups = 0;
  const service = new NotificationService(
    repository,
    {
      async requireSession() {
        if (!session) throw new AppError("FORBIDDEN", 401);
      },
      async profile() {
        if (!member) throw new AppError("FORBIDDEN", 403);
        return { verifiedEmail };
      },
      async source() {
        if (!allowed || !member) throw new AppError("FORBIDDEN", 403);
        return { version: 1 };
      },
    },
    {
      get configured() {
        return configured;
      },
      async send(input) {
        sends.push(input);
        return result;
      },
      async lookup() {
        lookups++;
        return lookup;
      },
    },
    "https://app.example.test",
  );
  const event = eventEnvelope.parse({
    eventId: randomUUID(),
    type: "summary.ready.v1",
    schemaVersion: 1,
    workspaceId: actor.workspaceId,
    aggregateId: randomUUID(),
    aggregateVersion: 1,
    occurredAt: "2026-10-13T00:00:00Z",
    traceId: randomUUID().replaceAll("-", ""),
    actorId: actor.actorId,
    references: [{ kind: "meeting", id: meetingId, revision: 1 }],
  });
  return {
    actor,
    meetingId,
    service,
    event,
    sends,
    get lookups() {
      return lookups;
    },
    set allowed(value: boolean) {
      allowed = value;
    },
    set member(value: boolean) {
      member = value;
    },
    set session(value: boolean) {
      session = value;
    },
    set configured(value: boolean) {
      configured = value;
    },
    set verifiedEmail(value: string | null) {
      verifiedEmail = value;
    },
    set result(value: EmailResult) {
      result = value;
    },
    set lookup(value: EmailLookup) {
      lookup = value;
    },
    async prefs(email = true, hour: number | null = null) {
      return service.savePreferences(actor, randomUUID(), {
        expectedVersion: 0,
        inApp: true,
        email,
        deliveryHourUtc: hour,
        emailConsent: email,
      });
    },
    async refs() {
      return (
        await pool.query("SELECT delivery_id FROM delivery_work_index WHERE workspace_id=$1", [
          actor.workspaceId,
        ])
      ).rows.map((row) => String(row.delivery_id));
    },
    async delivery(id: string) {
      return repository.transaction(actor.workspaceId, (tx) => tx.delivery(id));
    },
  };
}
test("preference consent/version/idempotency protects scheduling and events never enable delivery by themselves", async () => {
  const f = fixture();
  await f.service.receive(f.event);
  assert.equal((await f.refs()).length, 0);
  await assert.rejects(
    f.service.savePreferences(f.actor, "key", {
      expectedVersion: 0,
      inApp: true,
      email: true,
      deliveryHourUtc: null,
      emailConsent: false,
    }),
    /EMAIL_CONSENT_REQUIRED/,
  );
  const body = {
    expectedVersion: 0,
    inApp: true,
    email: true,
    deliveryHourUtc: null,
    emailConsent: true,
  };
  const saved = await f.service.savePreferences(f.actor, "prefs", body);
  assert.equal((await f.service.savePreferences(f.actor, "prefs", body)).version, saved.version);
  await assert.rejects(
    f.service.savePreferences(f.actor, "prefs", { ...body, email: false }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(f.service.savePreferences(f.actor, "other", body), /VERSION_CONFLICT/);
});
test("duplicate events enqueue once, in-app delivery and generic email survive normal logout without exposing meeting text", async () => {
  const f = fixture();
  await f.prefs();
  await Promise.all([
    f.service.receive(f.event),
    f.service.receive(f.event),
    f.service.receive(f.event),
  ]);
  assert.equal((await f.refs()).length, 2);
  f.session = false;
  for (const id of await f.refs()) await f.service.work(f.actor.workspaceId, id);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0]!.subject, "Your VisualSprint update is ready");
  assert.equal(
    f.sends[0]!.text,
    `An update is ready in your VisualSprint workspace. Open https://app.example.test/w/${f.actor.workspaceId}`,
  );
  assert.equal(f.sends[0]!.text.includes(f.meetingId), false);
  await assert.rejects(f.service.list(f.actor), /FORBIDDEN/);
  f.session = true;
  const listed = await f.service.list(f.actor);
  assert.equal(listed.items.length, 1);
  const item = listed.items[0]!;
  const read = await f.service.markRead(f.actor, item.id, { expectedVersion: item.version });
  assert.ok(read.readAt);
  assert.equal(
    (await f.service.markRead(f.actor, item.id, { expectedVersion: item.version })).readAt,
    read.readAt,
  );
});
test("uncertain email only reconciles; authoritative no-send permits retry and stale workers cannot finish", async () => {
  const f = fixture();
  await f.prefs();
  await f.service.receive(f.event);
  const ids = await f.refs();
  const id = (await Promise.all(ids.map((id) => f.delivery(id)))).find(
    (row) => row.channel === "email",
  )!.id;
  f.result = { state: "unknown" };
  await f.service.work(f.actor.workspaceId, id);
  assert.equal((await f.delivery(id)).state, "unknown");
  await f.service.work(f.actor.workspaceId, id);
  assert.equal(f.sends.length, 1);
  assert.equal(f.lookups, 1);
  f.lookup = { state: "not_sent" };
  await f.service.work(f.actor.workspaceId, id);
  assert.equal((await f.delivery(id)).state, "queued");
  f.result = { state: "sent", externalId: "confirmed-email" };
  await f.service.work(f.actor.workspaceId, id);
  assert.equal(f.sends.length, 2);
  assert.equal((await f.delivery(id)).externalId, "confirmed-email");
  const g = fixture();
  await g.prefs(false);
  await g.service.receive(g.event);
  const gId = (await g.refs())[0]!;
  const claim = await repository.transaction(g.actor.workspaceId, (tx) => tx.claim(gId));
  assert.ok(claim);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [g.actor.workspaceId]);
    await client.query("UPDATE deliveries SET lease_until=now()-interval '1 second' WHERE id=$1", [
      gId,
    ]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  await g.service.work(g.actor.workspaceId, gId);
  await assert.rejects(
    repository.transaction(g.actor.workspaceId, (tx) => tx.finish(claim, "delivered", null, null)),
    /STALE_WORKER/,
  );
});
test("revoked source or unavailable email setup holds delivery and denies previous in-app reads", async () => {
  const f = fixture();
  await f.prefs();
  await f.service.receive(f.event);
  f.allowed = false;
  for (const id of await f.refs()) await f.service.work(f.actor.workspaceId, id);
  assert.equal(f.sends.length, 0);
  for (const id of await f.refs()) assert.equal((await f.delivery(id)).state, "held");
  f.allowed = true;
  f.verifiedEmail = null;
  for (const id of await f.refs()) await f.service.work(f.actor.workspaceId, id);
  assert.equal(f.sends.length, 0);
  assert.equal((await f.service.list(f.actor)).items.length, 1);
  f.allowed = false;
  assert.equal((await f.service.list(f.actor)).items.length, 0);
});
test("scheduled emails wait for UTC delivery time and current preference disable cancels queued work", async () => {
  const f = fixture();
  await f.prefs(true, new Date().getUTCHours());
  await f.service.receive(f.event);
  const rows = await Promise.all((await f.refs()).map((id) => f.delivery(id)));
  const email = rows.find((row) => row.channel === "email")!;
  assert.ok(email.availableAt > new Date());
  await f.service.work(f.actor.workspaceId, email.id);
  assert.equal(f.sends.length, 0);
  await f.service.savePreferences(f.actor, "off", {
    expectedVersion: 1,
    inApp: false,
    email: false,
    deliveryHourUtc: null,
    emailConsent: false,
  });
  for (const id of await f.refs()) {
    assert.equal((await f.delivery(id)).state, "cancelled");
    await repository.reschedule(f.actor.workspaceId, id);
  }
  assert.equal((await f.refs()).length, 0);
});
test("Workspace deletion tombstone purges deliveries/attempts and prevents reordered events resurrecting notifications", async () => {
  const f = fixture();
  await f.prefs();
  await f.service.receive(f.event);
  f.result = { state: "unknown" };
  for (const id of await f.refs()) await f.service.work(f.actor.workspaceId, id);
  const deletionId = randomUUID();
  const ack = await f.service.deleteMeeting(f.actor, deletionId, {
    meetingId: f.meetingId,
    sourceVersion: 1,
  });
  assert.deepEqual(ack, {
    deletionId,
    meetingId: f.meetingId,
    participant: "notification",
    state: "complete",
  });
  await f.service.deleteMeeting(f.actor, deletionId, { meetingId: f.meetingId, sourceVersion: 1 });
  await assert.rejects(
    f.service.deleteMeeting(f.actor, deletionId, { meetingId: randomUUID(), sourceVersion: 1 }),
    /DELETION_TARGET_CONFLICT/,
  );
  await f.service.receive({ ...f.event, eventId: randomUUID() });
  assert.equal((await f.refs()).length, 0);
  assert.equal((await f.service.list(f.actor)).items.length, 0);
});
test("authenticated event origins and public/deletion tenant scope fail closed", async () => {
  const f = fixture();
  await f.prefs(false);
  const app = notificationApp(
    f.service,
    async (token) => (token === "grant" ? { ...f.actor, operationGrantId: randomUUID() } : f.actor),
    async (token) => ({ caller: token, actor: f.actor }),
    async (token) => {
      if (token !== "workspace-proof") throw new AppError("UNAUTHENTICATED_SERVICE", 401);
      return f.actor;
    },
  );
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/internal/workspaces/${f.actor.workspaceId}/events`,
          headers: { authorization: "Bearer workflow" },
          payload: f.event,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/internal/workspaces/${f.actor.workspaceId}/events`,
          headers: { authorization: "Bearer intelligence" },
          payload: f.event,
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v3/workspaces/${f.actor.workspaceId}/notification-preferences`,
          headers: { authorization: "Bearer grant" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v3/workspaces/${randomUUID()}/notifications`,
          headers: { authorization: "Bearer owner" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/internal/workspaces/${f.actor.workspaceId}/deletions/${randomUUID()}`,
          headers: { authorization: "Bearer untrusted" },
          payload: { meetingId: f.meetingId, sourceVersion: 1 },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await pool.query("SELECT * FROM preferences WHERE workspace_id=$1", [f.actor.workspaceId]))
        .rowCount,
      0,
    );
  } finally {
    await app.close();
  }
});
test("owning outbox retries immutable metadata after lost acknowledgement and email configuration never invents a verified destination", async () => {
  const f = fixture();
  f.configured = false;
  await f.prefs();
  await f.service.receive(f.event);
  for (const id of await f.refs()) await f.service.work(f.actor.workspaceId, id);
  assert.equal(f.sends.length, 0);
  const rows = await Promise.all((await f.refs()).map((id) => f.delivery(id)));
  assert.equal(rows.find((row) => row.channel === "email")!.errorCode, "EMAIL_NOT_CONFIGURED");
  const seen: string[] = [];
  await assert.rejects(
    repository.publish(f.actor.workspaceId, {
      async publish(event) {
        seen.push(event.eventId);
        throw new Error("ACK_UNKNOWN");
      },
    }),
    /ACK_UNKNOWN/,
  );
  assert.equal(
    await repository.publish(f.actor.workspaceId, {
      async publish() {
        throw new Error("LEASE_BROKEN");
      },
    }),
    0,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
    await client.query("UPDATE outbox SET lease_until=now()-interval '1 second'");
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const replay: string[] = [];
  assert.ok(
    (await repository.publish(f.actor.workspaceId, {
      async publish(event) {
        replay.push(event.eventId);
        assert.equal(event.type, "notification.delivery.changed.v1");
        assert.equal(JSON.stringify(event).includes("example.test"), false);
      },
    })) > 0,
  );
  assert.ok(replay.includes(seen[0]!));
});
test("public owner and tenant barriers prevent delivery IDs becoming source-read authorization", async () => {
  const f = fixture();
  await f.prefs(false);
  await f.service.receive(f.event);
  const id = (await f.refs())[0]!;
  await f.service.work(f.actor.workspaceId, id);
  await assert.rejects(
    repository.transaction(randomUUID(), (tx) => tx.delivery(id)),
    /NOT_FOUND/,
  );
  await assert.rejects(
    f.service.markRead({ ...f.actor, actorId: randomUUID() }, id, {
      expectedVersion: (await f.delivery(id)).version,
    }),
    /NOT_FOUND/,
  );
  await assert.rejects(f.service.receive({ ...f.event, aggregateVersion: 2 }), /EVENT_ID_CONFLICT/);
});
