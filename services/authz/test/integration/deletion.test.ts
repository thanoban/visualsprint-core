import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { databasePool, migrate, assertRuntimeRole, AppError } from "@visualsprint/platform";
import { PostgresAuthzDeletions } from "../../src/deletion-store.js";
import { AuthzDeletionService } from "../../src/deletion-service.js";
import { OpenFgaMeetingPurge } from "../../src/deletion-provider.js";
import { OpenFgaPolicy } from "../../src/policy.js";
import { bootstrap } from "../../src/bootstrap.js";
import { authzApp } from "../../src/app.js";
import { authzDeletionRoutes } from "../../src/deletion-routes.js";
const migration = databasePool(
    "postgres://vs_authz_app_migration:local-migration-only@127.0.0.1:55435/authz_application",
    1,
  ),
  pool = databasePool(
    "postgres://vs_authz_app_runtime:local-runtime-only@127.0.0.1:55435/authz_application",
    3,
  ),
  repository = new PostgresAuthzDeletions(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
test("real DB/OpenFGA purge deletes only target tuples and persisted barrier defeats stale ACL facts", async () => {
  const origin = "http://127.0.0.1:4180",
    key = "local-openfga-only",
    ids = await bootstrap(origin, key, `authz-delete-${randomUUID()}`),
    actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "fixture" },
    meetingId = randomUUID(),
    otherMeeting = randomUUID(),
    object = `meeting:${actor.workspaceId}/${meetingId}`,
    otherObject = `meeting:${actor.workspaceId}/${otherMeeting}`;
  try {
    const tuples = [
      { user: "user:" + actor.actorId, relation: "owner", object },
      { user: "workspace:" + actor.workspaceId, relation: "workspace", object },
      { user: "user:" + randomUUID(), relation: "viewer", object },
      { user: "user:" + actor.actorId, relation: "owner", object: otherObject },
    ];
    assert.equal(
      (
        await fetch(`${origin}/stores/${ids.storeId}/write`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            writes: { tuple_keys: tuples },
            authorization_model_id: ids.modelId,
          }),
        })
      ).ok,
      true,
    );
    const policy = new OpenFgaPolicy(origin, key, ids.storeId, ids.modelId, repository),
      facts = {
        meetingId,
        ownerId: actor.actorId,
        reader: false,
        blocked: false,
        activeMember: true,
        relation: "can_view" as const,
      };
    assert.equal(await policy.check(actor, facts), true);
    const service = new AuthzDeletionService(
        repository,
        new OpenFgaMeetingPurge(origin, key, ids.storeId, ids.modelId),
      ),
      deletionId = randomUUID(),
      body = { meetingId, sourceVersion: 2 };
    const ack = await service.delete(actor, deletionId, body);
    assert.equal(ack.state, "complete");
    assert.equal(await policy.check(actor, facts), false);
    const read = await fetch(`${origin}/stores/${ids.storeId}/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ tuple_key: { object } }),
    });
    assert.deepEqual(((await read.json()) as { tuples: unknown[] }).tuples, []);
    const keep = await fetch(`${origin}/stores/${ids.storeId}/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ tuple_key: { object: otherObject } }),
    });
    assert.equal(((await keep.json()) as { tuples: unknown[] }).tuples.length, 1);
    await service.delete(actor, deletionId, body);
    await assert.rejects(
      service.delete(actor, deletionId, { ...body, meetingId: otherMeeting }),
      (e) => e instanceof AppError && e.code === "DELETION_TARGET_CONFLICT",
    );
    assert.equal(await repository.blocked(randomUUID(), meetingId), false);
    let reads = 0;
    const postBarrier = new OpenFgaPolicy(origin, key, ids.storeId, ids.modelId, {
      async blocked() {
        return ++reads > 1;
      },
    });
    assert.equal(await postBarrier.check(actor, { ...facts, meetingId: otherMeeting }), false);
  } finally {
    assert.equal(
      (
        await fetch(`${origin}/stores/${ids.storeId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${key}` },
        })
      ).ok,
      true,
    );
  }
});
test("provider outage retains barrier, cleanup survives logout and HTTP rejects untrusted caller/tenant", async () => {
  const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "revoked-session" },
    meetingId = randomUUID(),
    deletionId = randomUUID(),
    body = { meetingId, sourceVersion: 1 };
  let unavailable = true,
    calls = 0;
  const service = new AuthzDeletionService(repository, {
    async remove() {
      calls++;
      if (unavailable) throw new AppError("AUTHZ_CLEANUP_PENDING", 503);
    },
  });
  assert.equal((await service.delete(actor, deletionId, body)).state, "pending");
  assert.equal(await repository.blocked(actor.workspaceId, meetingId), true);
  const auth = async (token: string) => {
    if (token !== "workspace-fixture") throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    return actor;
  };
  const policy = new OpenFgaPolicy(
      "http://127.0.0.1:1",
      "fixture",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repository,
    ),
    app = authzApp(policy, auth);
  authzDeletionRoutes(app, service, auth);
  try {
    const url = `/internal/workspaces/${actor.workspaceId}/deletions/${deletionId}`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: "Bearer gateway-fixture" },
          payload: body,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/internal/workspaces/${randomUUID()}/deletions/${deletionId}`,
          headers: { authorization: "Bearer workspace-fixture" },
          payload: body,
        })
      ).statusCode,
      403,
    );
    unavailable = false;
    const response = await app.inject({
      method: "POST",
      url,
      headers: { authorization: "Bearer workspace-fixture" },
      payload: body,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().state, "complete");
    assert.equal(calls, 2);
    unavailable = true;
    assert.equal(
      (await service.delete(actor, deletionId, body)).state,
      "pending",
      "restore replay must not trust an old provider cleanup acknowledgement",
    );
    assert.equal(await repository.blocked(actor.workspaceId, meetingId), true);
  } finally {
    await app.close();
  }
});
