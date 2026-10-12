import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AppError,
  databasePool,
  assertRuntimeRole,
  migrate,
  type Actor,
} from "@visualsprint/platform";
import { CaptureService } from "../../src/application/capture-service.js";
import { PostgresCapture } from "../../src/infrastructure/store.js";
import type { ManagedCaptureProvider } from "../../src/application/capture-provider.js";
import { RecallSignatures } from "../../src/infrastructure/webhook-signature.js";
import { ingestApp } from "../../src/http/app.js";
const migrationPool = databasePool(
  process.env.INGEST_TEST_MIGRATION_URL ??
    "postgres://vs_ingest_migration:local-migration-only@127.0.0.1:55436/ingest",
  1,
);
const pool = databasePool(
  process.env.INGEST_TEST_DATABASE_URL ??
    "postgres://vs_ingest_runtime:local-runtime-only@127.0.0.1:55436/ingest",
  3,
);
const repository = new PostgresCapture(pool);
before(async () => {
  await migrate(migrationPool, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migrationPool.end();
});
test("worker index contains only routing IDs and completed cleanup removes work", async () => {
  const f = fixture();
  const requested = await f.request();
  assert.equal(
    (
      await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='capture_work_index' ORDER BY column_name",
      )
    ).rows
      .map((row) => row.column_name)
      .join(","),
    "next_at,request_id,workspace_id",
  );
  await f.service.stop(f.actor, requested.id);
  await f.service.work(f.actor.workspaceId, requested.id);
  await repository.reschedule(f.actor.workspaceId, requested.id);
  assert.equal(
    (await pool.query("SELECT 1 FROM capture_work_index WHERE request_id=$1", [requested.id]))
      .rowCount,
    0,
  );
});
test("owning outbox retries a lost broker acknowledgement with the same event identity", async () => {
  const f = fixture();
  await f.request();
  const deliveries: string[] = [];
  await assert.rejects(
    repository.publish(f.actor.workspaceId, {
      async publish(event) {
        deliveries.push(event.eventId);
        assert.equal(JSON.stringify(event).includes("meet.google.com"), false);
        throw new Error("BROKER_ACK_UNKNOWN");
      },
    }),
    /BROKER_ACK_UNKNOWN/,
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
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  assert.equal(
    await repository.publish(f.actor.workspaceId, {
      async publish(event) {
        deliveries.push(event.eventId);
      },
    }),
    1,
  );
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0], deliveries[1]);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM event_work_index WHERE workspace_id=$1", [
        f.actor.workspaceId,
      ])
    ).rowCount,
    1,
  );
  assert.ok((await repository.eventWorkspaces()).length <= 20);
});
test("transcript paging is complete and a provider replay cannot replace a human revision", async () => {
  const f = fixture();
  const requested = await f.request();
  const record = (await repository.scoped(f.actor.workspaceId, (tx) => tx.load(requested.id)))!;
  const corrected = randomUUID();
  await repository.scoped(f.actor.workspaceId, async (tx) => {
    for (let index = 0; index < 105; index++)
      await tx.storeSegment(requested.id, {
        id: index === 0 ? corrected : randomUUID(),
        revision: index === 0 ? 2 : 1,
        startMs: index * 1000,
        endMs: index * 1000 + 500,
        text: index === 0 ? "Human correction" : `Segment ${index}`,
        speakerLabel: null,
        finalized: true,
      });
  });
  await f.service.receive("recall", "human-replay", "revision-digest", {
    kind: "transcript",
    attemptId: record.attemptId,
    providerId: f.providerId,
    segment: {
      id: corrected,
      revision: 1,
      startMs: 0,
      endMs: 500,
      text: "Old machine text",
      speakerLabel: null,
      finalized: true,
    },
  });
  const first = await f.service.transcript(f.actor, requested.id);
  assert.equal(first.totalSegments, 105);
  assert.equal(first.segments.length, 100);
  assert.equal(first.segments[0]?.text, "Human correction");
  assert.ok(first.nextCursor);
  const second = await f.service.transcript(f.actor, requested.id, first.nextCursor);
  assert.equal(second.segments.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.segments, ...second.segments].map((segment) => segment.id)).size,
    105,
  );
});
test("absolute duration stops capture without treating quiet audio as meeting end", async () => {
  const f = fixture();
  const requested = await f.request();
  await f.service.work(f.actor.workspaceId, requested.id);
  f.advance(119000);
  await f.service.work(f.actor.workspaceId, requested.id);
  assert.equal(f.counters().leaves, 0);
  f.advance(1000);
  await f.service.work(f.actor.workspaceId, requested.id);
  assert.equal(f.counters().leaves, 1);
  assert.equal((await f.service.status(f.actor, requested.id)).state, "stopping");
});
function fixture(kind: "accepted" | "unknown" | "capacity" = "accepted", loseReserveReply = false) {
  const actor: Actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    sessionId: "capture-test",
  };
  const meetingId = randomUUID(),
    providerId = randomUUID();
  let now = new Date("2026-10-12T10:00:00Z"),
    creates = 0,
    leaves = 0,
    releases = 0,
    settlements = 0,
    allowed = true;
  let status = "in_call_recording";
  let held = false;
  const provider: ManagedCaptureProvider = {
    async create() {
      creates++;
      return kind === "accepted"
        ? { kind, providerId }
        : kind === "capacity"
          ? { kind, retryAfterSeconds: 30 }
          : { kind };
    },
    async findAttempt() {
      return { kind: "not_found" };
    },
    async inspect() {
      return { providerId, status, occurredAt: now.toISOString() };
    },
    async leave() {
      leaves++;
      return "accepted";
    },
  };
  const authority = {
    async capture() {
      if (!allowed) throw new AppError("FORBIDDEN", 403);
      return {
        meetingId,
        ownerId: actor.actorId,
        joinUrl: "https://meet.google.com/abc-defg-hij",
        version: 1,
      };
    },
    async read() {
      if (!allowed) throw new AppError("FORBIDDEN", 403);
    },
    async manage() {
      if (!allowed) throw new AppError("FORBIDDEN", 403);
    },
  };
  const service = new CaptureService(
    repository,
    authority,
    {
      async reserve() {
        const first = !held;
        held = true;
        if (first && loseReserveReply) throw new AppError("ACCOUNT_UNAVAILABLE", 503);
        return "held";
      },
      async lookup() {
        return held ? { state: "held", maxSeconds: 120 } : null;
      },
      async release() {
        releases++;
      },
      async settle() {
        settlements++;
      },
    },
    provider,
    "https://capture.example/webhooks/v3/recall",
    () => now,
  );
  return {
    actor,
    meetingId,
    providerId,
    service,
    request: () =>
      service.request(actor, "capture-test-key", {
        meetingId,
        expectedMeetingVersion: 1,
        maxDurationSeconds: 120,
      }),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    end: () => {
      status = "done";
    },
    revoke: () => {
      allowed = false;
    },
    counters: () => ({ creates, leaves, releases, settlements }),
    now: () => now,
  };
}
test("durable intent, tenant isolation and uncertain dispatch never duplicate creation", async () => {
  const f = fixture("unknown");
  const first = await f.request();
  assert.deepEqual(await f.request(), first);
  assert.equal(await repository.scoped(randomUUID(), (tx) => tx.load(first.id)), undefined);
  await f.service.work(f.actor.workspaceId, first.id);
  assert.equal((await f.service.status(f.actor, first.id)).state, "dispatch_unknown");
  await f.service.work(f.actor.workspaceId, first.id);
  assert.equal(f.counters().creates, 1);
  assert.equal(f.counters().releases, 0);
  await assert.rejects(
    repository.attempt(randomUUID(), async () => undefined),
    /UNKNOWN_CAPTURE_ATTEMPT/,
  );
});
test("worker recovers a quota response lost after Account commit without another bot", async () => {
  const f = fixture("accepted", true);
  await assert.rejects(f.request(), /ACCOUNT_UNAVAILABLE/);
  const pending = (await repository.scoped(f.actor.workspaceId, (tx) => tx.list(f.meetingId)))[0]!;
  assert.equal(pending.ready, false);
  await f.service.work(f.actor.workspaceId, pending.id);
  assert.equal((await f.service.status(f.actor, pending.id)).ready, true);
  assert.equal(f.counters().creates, 1);
  await f.service.work(f.actor.workspaceId, pending.id);
  assert.equal(f.counters().creates, 1);
});
test("cancellation after a lost quota reply cleans the held reservation without dispatch", async () => {
  const f = fixture("accepted", true);
  await assert.rejects(f.request(), /ACCOUNT_UNAVAILABLE/);
  const pending = (await repository.scoped(f.actor.workspaceId, (tx) => tx.list(f.meetingId)))[0]!;
  await f.service.stop(f.actor, pending.id);
  await f.service.work(f.actor.workspaceId, pending.id);
  assert.equal(f.counters().creates, 0);
  assert.equal(f.counters().releases, 1);
});
test("stop while joining is durable; acceptance alone cannot finalize; late text drains", async () => {
  const f = fixture();
  const requested = await f.request();
  await f.service.work(f.actor.workspaceId, requested.id);
  const record = (await repository.scoped(f.actor.workspaceId, (tx) => tx.load(requested.id)))!;
  await f.service.stop(f.actor, requested.id);
  await f.service.work(f.actor.workspaceId, requested.id);
  assert.equal(f.counters().leaves, 1);
  assert.equal((await f.service.status(f.actor, requested.id)).state, "stopping");
  await f.service.receive("recall", "status-1", "digest-1", {
    kind: "status",
    attemptId: record.attemptId,
    providerId: f.providerId,
    code: "in_call_recording",
    subCode: null,
    occurredAt: f.now(),
  });
  assert.equal((await f.service.status(f.actor, requested.id)).state, "stopping");
  const segment = {
    id: randomUUID(),
    revision: 1,
    startMs: 0,
    endMs: 1000,
    text: "We approved the launch.",
    speakerLabel: "Founder",
    finalized: true,
  };
  const event = {
    kind: "transcript" as const,
    attemptId: record.attemptId,
    providerId: f.providerId,
    segment,
  };
  await f.service.receive("recall", "text-1", "text-digest", event);
  await f.service.receive("recall", "text-1", "text-digest", event);
  await assert.rejects(
    f.service.receive("recall", "text-1", "changed", event),
    /WEBHOOK_REPLAY_CONFLICT/,
  );
  assert.equal((await f.service.transcript(f.actor, requested.id)).segments.length, 1);
  f.advance(5000);
  f.end();
  await f.service.work(f.actor.workspaceId, requested.id);
  assert.equal((await f.service.status(f.actor, requested.id)).state, "finalizing");
  f.advance(31000);
  await f.service.work(f.actor.workspaceId, requested.id);
  assert.equal((await f.service.status(f.actor, requested.id)).state, "partial");
  assert.equal(f.counters().settlements, 1);
  await f.service.work(f.actor.workspaceId, requested.id);
  assert.equal(f.counters().settlements, 1);
  f.revoke();
  await assert.rejects(f.service.transcript(f.actor, requested.id), /FORBIDDEN/);
});
test("cancellation before dispatch and definitive capacity rejection release quota", async () => {
  const f = fixture();
  const requested = await f.request();
  await f.service.stop(f.actor, requested.id);
  await f.service.work(f.actor.workspaceId, requested.id);
  assert.deepEqual(f.counters(), { creates: 0, leaves: 0, releases: 1, settlements: 0 });
  const capacity = fixture("capacity");
  const other = await capacity.request();
  await capacity.service.work(capacity.actor.workspaceId, other.id);
  assert.equal((await capacity.service.status(capacity.actor, other.id)).state, "failed");
  assert.equal(capacity.counters().releases, 1);
});
test("signed raw-body webhook persists before acknowledgement; unsigned payload is denied", async () => {
  const f = fixture();
  const requested = await f.request();
  const record = (await repository.scoped(f.actor.workspaceId, (tx) => tx.load(requested.id)))!;
  const key = randomBytes(32);
  const app = ingestApp(
    f.service,
    async () => f.actor,
    new RecallSignatures([`whsec_${key.toString("base64")}`]),
  );
  try {
    const raw = JSON.stringify({
      event: "transcript.data",
      data: {
        bot: { id: f.providerId, metadata: { attempt_id: record.attemptId } },
        transcript: { id: randomUUID() },
        data: {
          words: [
            { text: "Test", start_timestamp: { relative: 0 }, end_timestamp: { relative: 1 } },
          ],
          participant: { id: 1, name: "Founder" },
        },
      },
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/v3/recall",
          payload: raw,
          headers: { "content-type": "application/json" },
        })
      ).statusCode,
      401,
    );
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", key)
      .update(`msg_test.${timestamp}.${raw}`)
      .digest("base64");
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/v3/recall",
      payload: raw,
      headers: {
        "content-type": "application/json",
        "webhook-id": "msg_test",
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
    });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal((await f.service.transcript(f.actor, requested.id)).segments[0]?.text, "Test");
  } finally {
    await app.close();
  }
});
