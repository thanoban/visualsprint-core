import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair } from "jose";
import {
  AppError,
  assertRuntimeRole,
  databasePool,
  migrate,
  ServiceIdentity,
  serviceToken,
  type Actor,
} from "@visualsprint/platform";
import { eventEnvelope } from "@visualsprint/contracts";
import { PostgresWorkspace } from "../../src/infrastructure/store.js";
import { WorkspaceService } from "../../src/application/workspace.js";
import { workspaceApp } from "../../src/http/app.js";

// Explicit invocation fails when PostgreSQL is missing; this suite never silently skips RLS.
const migrationPool = databasePool(
  process.env.WORKSPACE_TEST_MIGRATION_URL ??
    "postgres://vs_workspace_migration:local-migration-only@127.0.0.1:55433/workspace",
  1,
);
const runtimePool = databasePool(
  process.env.WORKSPACE_TEST_DATABASE_URL ??
    "postgres://vs_workspace_runtime:local-runtime-only@127.0.0.1:55433/workspace",
  2,
);
const repository = new PostgresWorkspace(runtimePool);
const owner: Actor = {
  workspaceId: randomUUID(),
  actorId: randomUUID(),
  sessionId: "owner-session",
};
const reader: Actor = { ...owner, actorId: randomUUID(), sessionId: "reader-session" };
const outsider: Actor = { ...owner, actorId: randomUUID() };
const otherTenant: Actor = { ...owner, workspaceId: randomUUID() };
const active = new Set([owner.actorId, reader.actorId, outsider.actorId]);
const memberships = {
  async requireActive(actor: Actor) {
    if (!active.has(actor.actorId)) throw new AppError("FORBIDDEN", 403);
  },
  async requireMember(workspaceId: string, userId: string, actor: Actor) {
    if (workspaceId !== actor.workspaceId || !active.has(userId))
      throw new AppError("FORBIDDEN", 403);
  },
};
// Persistence tests isolate the remote policy port; composition tests run real OpenFGA.
const service = new WorkspaceService(repository, memberships, {
  async check() {
    return true;
  },
  async checkMany(_actor, checks) {
    return checks.map(() => true);
  },
});
test("calendar projection keeps stable private meetings, user notes and title corrections across source revisions", async () => {
  const input = {
    connectionId: randomUUID(),
    occurrenceId: randomUUID(),
    sourceVersion: 1,
    title: "Calendar title",
    joinUrl: "https://meet.google.com/abc-defg-hij",
    status: "confirmed",
    allDay: false,
    declined: false,
    startsAt: "2026-10-12T10:00:00Z",
    endsAt: "2026-10-12T11:00:00Z",
  };
  const first = await service.calendarMeeting(owner, input);
  assert.equal((await service.calendarMeeting(owner, input)).id, first.id);
  await assert.rejects(service.meeting(reader, first.id), /NOT_FOUND/);
  const edited = await service.edit(owner, first.id, randomUUID(), {
    expectedVersion: first.version,
    title: "Owner correction",
    notes: "Human evidence",
  });
  const changed = await service.calendarMeeting(owner, {
    ...input,
    sourceVersion: 2,
    title: "Vendor rename",
  });
  assert.equal(changed.id, first.id);
  assert.equal(changed.notes, edited.notes);
  assert.equal(changed.title, "Owner correction");
  assert.equal((await service.calendarMeeting(owner, input)).version, changed.version);
  await assert.rejects(
    service.calendarMeeting(owner, {
      ...input,
      sourceVersion: 2,
      title: "Conflicting vendor revision",
    }),
    /IDEMPOTENCY_CONFLICT|SOURCE_REVISION_CONFLICT/,
  );
  await service.calendarMeeting(owner, { ...input, sourceVersion: 3, status: "cancelled" });
  await assert.rejects(service.captureContext(owner, first.id), /OCCURRENCE_NOT_ELIGIBLE/);
  assert.equal((await service.meeting(owner, first.id)).notes, "Human evidence");
  const grant = randomUUID();
  await assert.rejects(
    service.calendarMeeting(
      { ...owner, operationGrantId: grant, sessionId: `operation:${grant}` },
      input,
    ),
    /FORBIDDEN/,
  );
});
before(async () => {
  await migrate(migrationPool, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(runtimePool);
});
test("intelligence scopes isolate projects/customers and sharing remains independent", async () => {
  const customer = await service.addCustomer(owner, randomUUID(), { name: "Scope customer" });
  const project = await service.addProject(owner, randomUUID(), {
    name: "Scope project",
    customerId: customer.id,
  });
  const other = await service.addProject(owner, randomUUID(), { name: "Other project" });
  const meeting = await service.addMeeting(owner, randomUUID(), { title: "Scoped evidence" });
  const separate = await service.addMeeting(owner, randomUUID(), { title: "Excluded evidence" });
  const assigned = await service.assign(owner, meeting.id, randomUUID(), {
    projectId: project.id,
    confirmed: true,
    expectedVersion: meeting.version,
  });
  await service.assign(owner, separate.id, randomUUID(), {
    projectId: other.id,
    confirmed: true,
    expectedVersion: separate.version,
  });
  for (const scope of [
    { kind: "project", id: project.id },
    { kind: "customer", id: customer.id },
  ]) {
    assert.deepEqual(
      (await service.intelligenceContext(owner, { scope })).meetings.map((m) => m.id),
      [meeting.id],
    );
    await assert.rejects(service.intelligenceContext(reader, { scope }), /NOT_FOUND/);
  }
  await assert.rejects(
    service.intelligenceContext(reader, { scope: { kind: "meeting", id: meeting.id } }),
    /NOT_FOUND/,
  );
  await service.share(owner, meeting.id, randomUUID(), {
    userId: reader.actorId,
    expectedVersion: assigned.version,
  });
  assert.equal(
    (await service.intelligenceContext(reader, { scope: { kind: "meeting", id: meeting.id } }))
      .meetings[0]!.id,
    meeting.id,
  );
  assert.deepEqual(
    (await service.intelligenceContext(otherTenant, { scope: { kind: "workspace", id: null } }))
      .meetings,
    [],
  );
  await assert.rejects(
    service.intelligenceContext(
      { ...owner, operationGrantId: randomUUID() },
      { scope: { kind: "workspace", id: null } },
    ),
    /FORBIDDEN/,
  );
});
after(async () => {
  await runtimePool.end();
  await migrationPool.end();
});

test("runtime has forced RLS, no schema ownership or migration-table write permission", async () => {
  const role = await runtimePool.query(
    "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
  );
  assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
  const tables = await runtimePool.query(
    "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('customers','projects','meetings','outbox','inbox') ORDER BY relname",
  );
  assert.equal(tables.rows.length, 5);
  for (const table of tables.rows) {
    assert.equal(table.relrowsecurity, true);
    assert.equal(table.relforcerowsecurity, true);
  }
  await assert.rejects(() => assertRuntimeRole(migrationPool), /UNSAFE_RUNTIME_DATABASE_ROLE/);
  await assert.rejects(
    () => runtimePool.query("UPDATE schema_migrations SET checksum='tampered'"),
    /permission denied/,
  );
});
test("PostgreSQL isolates tenants and clears transaction context on pooled reuse", async () => {
  const meeting = await service.addMeeting(owner, randomUUID(), { title: "Private founder call" });
  assert.equal((await service.meetings(otherTenant)).length, 0);
  await assert.rejects(() => service.meeting(otherTenant, meeting.id), /NOT_FOUND/);
  const raw = await runtimePool.query("SELECT * FROM meetings");
  assert.equal(raw.rowCount, 0);
  await assert.rejects(
    () =>
      runtimePool.query(
        "INSERT INTO meetings(workspace_id,id,owner_id,title) VALUES($1,$2,$3,'outside tenant')",
        [owner.workspaceId, randomUUID(), owner.actorId],
      ),
    /row-level security/,
  );
  await assert.rejects(
    () =>
      repository.read(otherTenant, (tx) =>
        tx.createCustomer({
          workspaceId: owner.workspaceId,
          id: randomUUID(),
          ownerId: owner.actorId,
          name: "Wrong tenant",
          version: 1,
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      "code" in error.cause &&
      error.cause.code === "42501",
  );
});
test("concurrent duplicate commands return one identity; changed payload conflicts", async () => {
  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      service.addMeeting(owner, key, { title: "Exactly one private meeting" }),
    ),
  );
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  await assert.rejects(
    () => service.addMeeting(owner, key, { title: "Changed request" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const events = await runtimePool.connect();
  try {
    await events.query("BEGIN");
    await events.query("SELECT set_config('app.workspace_id',$1,true)", [owner.workspaceId]);
    const count = await events.query(
      "SELECT count(*)::int AS count FROM outbox WHERE event->>'aggregateId'=$1",
      [results[0]!.id],
    );
    assert.equal(count.rows[0].count, 1);
    await events.query("ROLLBACK");
  } finally {
    events.release();
  }
});
test("assignment needs owner confirmation; sharing is independent and revocation is immediate", async () => {
  const customer = await service.addCustomer(owner, randomUUID(), { name: "Acme" });
  const project = await service.addProject(owner, randomUUID(), {
    name: "Renewal",
    customerId: customer.id,
  });
  const meeting = await service.addMeeting(owner, randomUUID(), { title: "Acme renewal" });
  await assert.rejects(() =>
    service.assign(owner, meeting.id, randomUUID(), {
      projectId: project.id,
      expectedVersion: 1,
      confirmed: false,
    }),
  );
  const assigned = await service.assign(owner, meeting.id, randomUUID(), {
    projectId: project.id,
    expectedVersion: 1,
    confirmed: true,
  });
  assert.equal(
    (await service.meetings(owner, project.id)).some((item) => item.id === meeting.id),
    true,
  );
  await assert.rejects(() => service.meeting(outsider, meeting.id), /NOT_FOUND/);
  await assert.rejects(
    () =>
      service.assign(outsider, meeting.id, randomUUID(), {
        projectId: project.id,
        expectedVersion: assigned.version,
        confirmed: true,
      }),
    /NOT_FOUND/,
  );
  const shared = await service.share(owner, meeting.id, randomUUID(), {
    userId: reader.actorId,
    expectedVersion: assigned.version,
  });
  assert.equal((await service.meeting(reader, meeting.id)).id, meeting.id);
  await assert.rejects(
    () =>
      service.edit(reader, meeting.id, randomUUID(), {
        expectedVersion: shared.version,
        notes: "unauthorized",
      }),
    /NOT_FOUND/,
  );
  await service.share(
    owner,
    meeting.id,
    randomUUID(),
    { userId: reader.actorId, expectedVersion: shared.version },
    true,
  );
  await assert.rejects(() => service.meeting(reader, meeting.id), /NOT_FOUND/);
  active.delete(owner.actorId);
  await assert.rejects(() => service.meeting(owner, meeting.id), /FORBIDDEN/);
  active.add(owner.actorId);
});
test("optimistic edits reject stale changes and idempotent replay checks deletion barrier", async () => {
  const createKey = randomUUID();
  const meeting = await service.addMeeting(owner, createKey, { title: "Versioned" });
  const key = randomUUID();
  const changed = await service.edit(owner, meeting.id, key, {
    expectedVersion: 1,
    notes: "Human correction",
  });
  assert.equal(changed.version, 2);
  await assert.rejects(
    () =>
      service.edit(owner, meeting.id, randomUUID(), {
        expectedVersion: 1,
        notes: "Stale overwrite",
      }),
    /VERSION_CONFLICT/,
  );
  const client = await runtimePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [owner.workspaceId]);
    await client.query("UPDATE meetings SET blocked=true WHERE id=$1", [meeting.id]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  await assert.rejects(
    () => service.edit(owner, meeting.id, key, { expectedVersion: 1, notes: "Human correction" }),
    /NOT_FOUND/,
  );
  await assert.rejects(
    () => service.addMeeting(owner, createKey, { title: "Versioned" }),
    /NOT_FOUND/,
  );
});
test("transaction failure rolls back both business data and its outbox event", async () => {
  const id = randomUUID();
  await assert.rejects(() =>
    repository.command(owner, randomUUID(), "fixture-fingerprint", async (tx) => {
      await tx.createCustomer({
        id,
        workspaceId: owner.workspaceId,
        ownerId: owner.actorId,
        name: "Must roll back",
        version: 1,
      });
      await tx.emit(
        eventEnvelope.parse({
          eventId: randomUUID(),
          type: "customer.created.v1",
          schemaVersion: 1,
          workspaceId: owner.workspaceId,
          aggregateId: id,
          aggregateVersion: 1,
          occurredAt: new Date().toISOString(),
          traceId: randomBytes(16).toString("hex"),
          actorId: owner.actorId,
          references: [{ kind: "customer", id }],
        }),
      );
      throw new Error("simulated crash");
    }),
  );
  assert.equal(await repository.read(owner, (tx) => tx.customer(id)), undefined);
  const emitted: string[] = [];
  await repository.publish(owner.workspaceId, {
    async publish(event) {
      emitted.push(event.aggregateId);
    },
  });
  assert.equal(emitted.includes(id), false);
});
test("outbox can redeliver after crash; inbox effects and deduplication commit atomically", async () => {
  const actor = { ...owner, workspaceId: randomUUID() };
  await service.addMeeting(actor, randomUUID(), { title: "Crash recovery" });
  const delivered: ReturnType<typeof eventEnvelope.parse>[] = [];
  await assert.rejects(() =>
    repository.publish(actor.workspaceId, {
      async publish(event) {
        delivered.push(event);
        throw new Error("crash after broker accepted");
      },
    }),
  );
  const client = await runtimePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [actor.workspaceId]);
    await client.query("UPDATE outbox SET lease_until=now()-interval '1 second'");
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  assert.equal(
    await repository.publish(actor.workspaceId, {
      async publish(event) {
        delivered.push(event);
      },
    }),
    1,
  );
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0]!.eventId, delivered[1]!.eventId);
  const customerId = randomUUID();
  await assert.rejects(() =>
    repository.consume(delivered[0]!, async (tx) => {
      await tx.createCustomer({
        id: customerId,
        workspaceId: actor.workspaceId,
        ownerId: actor.actorId,
        name: "Consumer",
        version: 1,
      });
      throw new Error("consumer crash");
    }),
  );
  assert.equal(await repository.read(actor, (tx) => tx.customer(customerId)), undefined);
  const first = await repository.consume(delivered[0]!, (tx) =>
    tx.createCustomer({
      id: customerId,
      workspaceId: actor.workspaceId,
      ownerId: actor.actorId,
      name: "Consumer",
      version: 1,
    }),
  );
  assert.equal(first.duplicate, false);
  assert.equal(
    (
      await repository.consume(delivered[1]!, async () => {
        throw new Error("must not execute duplicate");
      })
    ).duplicate,
    true,
  );
});
test("HTTP uses signed delegated identity and never trusts supplied actor/tenant headers", async () => {
  const keys = await generateKeyPair("EdDSA");
  const identity = new ServiceIdentity("workspace", {
    gateway: [{ ...(await exportJWK(keys.publicKey)), kid: "test" }],
  });
  const app = workspaceApp(service, async (token) => (await identity.verify(token)).actor);
  const token = await serviceToken({
    caller: "gateway",
    audience: "workspace",
    actor: owner,
    keyId: "test",
    privateKey: keys.privateKey,
  });
  const url = `/api/v3/workspaces/${owner.workspaceId}/meetings`;
  try {
    const missing = await app.inject({
      url,
      headers: { "x-actor-id": owner.actorId, "x-workspace-id": owner.workspaceId },
    });
    assert.equal(missing.statusCode, 401);
    const forgedTenant = await app.inject({
      url: `/api/v3/workspaces/${otherTenant.workspaceId}/meetings`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(forgedTenant.statusCode, 403);
    const created = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      payload: { title: "HTTP private meeting" },
    });
    assert.equal(created.statusCode, 201);
    const injectedOwner = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      payload: { title: "Bad owner", ownerId: outsider.actorId },
    });
    assert.equal(injectedOwner.statusCode, 400);
    assert.equal(injectedOwner.body.includes(outsider.actorId), false);
  } finally {
    await app.close();
  }
});
