import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK } from "jose";
import Fastify from "fastify";
import {
  AppError,
  databasePool,
  migrate,
  assertRuntimeRole,
  ServiceIdentity,
  serviceToken,
  installErrorHandler,
  type Actor,
} from "@visualsprint/platform";
import {
  CaptureProcessingContext,
  type ProcessingContextInput,
} from "../../src/application/capture-processing-context.js";
import { PostgresProcessingMeetings } from "../../src/infrastructure/processing-meetings.js";
import { captureProcessingContextRoutes } from "../../src/http/capture-processing-context-routes.js";
import { PostgresDeletions } from "../../src/infrastructure/deletion-store.js";
const migration = databasePool(
    process.env.WORKSPACE_TEST_MIGRATION_URL ??
      "postgres://vs_workspace_migration:local-migration-only@127.0.0.1:55433/workspace",
    1,
  ),
  pool = databasePool(
    process.env.WORKSPACE_TEST_DATABASE_URL ??
      "postgres://vs_workspace_runtime:local-runtime-only@127.0.0.1:55433/workspace",
    3,
  );
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function fixture() {
  const input: ProcessingContextInput = {
    consentId: randomUUID(),
    expectedVersion: 1,
    meetingId: randomUUID(),
    captureId: randomUUID(),
    policyVersion: "english-text-v1",
  };
  const owner: Actor = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      sessionId: "owner-session",
    },
    actor: Actor = {
      ...owner,
      operationGrantId: input.consentId,
      sessionId: `operation:${input.consentId}`,
    };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [owner.workspaceId]);
    await client.query(
      "INSERT INTO meetings(workspace_id,id,owner_id,title,notes,join_url) VALUES($1,$2,$3,'Private title','Never exposed notes','https://zoom.us/j/123456789?pwd=private')",
      [owner.workspaceId, input.meetingId, owner.actorId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  let active = true;
  const service = new CaptureProcessingContext(new PostgresProcessingMeetings(pool), {
    async authorize(a, i) {
      if (
        !active ||
        a.workspaceId !== owner.workspaceId ||
        a.actorId !== owner.actorId ||
        i.captureId !== input.captureId ||
        i.meetingId !== input.meetingId ||
        i.consentId !== input.consentId ||
        i.expectedVersion !== 1
      )
        throw new AppError("FORBIDDEN", 403);
      return {
        consentId: input.consentId,
        workspaceId: owner.workspaceId,
        ownerId: owner.actorId,
        meetingId: input.meetingId,
        captureId: input.captureId,
        version: 1,
        policyVersion: "english-text-v1",
        active: true,
      };
    },
  });
  return {
    input,
    owner,
    actor,
    service,
    revoke: () => {
      active = false;
    },
  };
}
test("scoped processing reads only owner/unblocked metadata; withdrawal and cross-tenant targets fail closed", async () => {
  const f = await fixture();
  assert.deepEqual(await f.service.read(f.actor, f.input), {
    meetingId: f.input.meetingId,
    ownerId: f.owner.actorId,
    meetingVersion: 1,
  });
  assert.equal(JSON.stringify(await f.service.read(f.actor, f.input)).includes("Private"), false);
  await assert.rejects(f.service.read(f.owner, f.input), /FORBIDDEN/);
  await assert.rejects(
    f.service.read({ ...f.actor, workspaceId: randomUUID() }, f.input),
    /FORBIDDEN/,
  );
  await assert.rejects(
    f.service.read(f.actor, { ...f.input, captureId: randomUUID() }),
    /FORBIDDEN/,
  );
  assert.equal(
    await new PostgresProcessingMeetings(pool).metadata(
      { ...f.actor, workspaceId: randomUUID() },
      f.input.meetingId,
    ),
    undefined,
  );
  f.revoke();
  await assert.rejects(f.service.read(f.actor, f.input), /FORBIDDEN/);
});
test("owning deletion barrier denies processing even while the remote proof remains active", async () => {
  const f = await fixture();
  await new PostgresDeletions(pool).request(
    f.owner,
    randomUUID(),
    { meetingId: f.input.meetingId, expectedVersion: 1 },
    ["intelligence"],
  );
  await assert.rejects(f.service.read(f.actor, f.input), /NOT_FOUND/);
});
test("processing route accepts only pinned Ingest/Intelligence operation proofs, not normal users or other callers", async () => {
  const f = await fixture(),
    keys = await generateKeyPair("EdDSA"),
    kid = "processing-fixture",
    jwk = { ...(await exportJWK(keys.publicKey)), kid };
  const identity = new ServiceIdentity("workspace", { ingest: [jwk], intelligence: [jwk] });
  const app = Fastify({ logger: false });
  installErrorHandler(app);
  captureProcessingContextRoutes(
    app,
    f.service,
    async (token) => (await identity.verify(token)).actor,
  );
  const token = async (caller: "ingest" | "intelligence" | "gateway", actor = f.actor) =>
    serviceToken({ caller, audience: "workspace", actor, privateKey: keys.privateKey, keyId: kid });
  const path = `/internal/workspaces/${f.actor.workspaceId}/meetings/${f.input.meetingId}/capture-processing-context`;
  try {
    for (const caller of ["ingest", "intelligence"] as const) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${await token(caller)}` },
        payload: f.input,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(Object.keys(response.json()).sort(), [
        "meetingId",
        "meetingVersion",
        "ownerId",
      ]);
    }
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${await token("gateway")}` },
          payload: f.input,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${await token("ingest", f.owner)}` },
          payload: f.input,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${await token("ingest")}` },
          payload: { ...f.input, meetingId: randomUUID() },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${await token("ingest")}` },
          payload: { ...f.input, notes: "unwanted read" },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});
