import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK } from "jose";
import {
  AppError,
  databasePool,
  migrate,
  assertRuntimeRole,
  ServiceIdentity,
  serviceToken,
  type Actor,
} from "@visualsprint/platform";
import { PostgresCapture } from "../../src/infrastructure/store.js";
import { CaptureService } from "../../src/application/capture-service.js";
import { ingestApp } from "../../src/http/app.js";
import { RecallSignatures } from "../../src/infrastructure/webhook-signature.js";

const migration = databasePool(
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
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});

function fixture() {
  const actor: Actor = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      sessionId: "export-owner",
    },
    meetingId = randomUUID();
  let permitted = true,
    reads = 0,
    revokeAfterFirst = false;
  const service = new CaptureService(
    repository,
    {
      async read(candidate, target) {
        reads++;
        if (
          !permitted ||
          candidate.workspaceId !== actor.workspaceId ||
          candidate.actorId !== actor.actorId ||
          target !== meetingId ||
          (revokeAfterFirst && reads > 1)
        )
          throw new AppError("FORBIDDEN", 403);
      },
      async capture() {
        throw new Error("no provider context");
      },
      async manage() {
        throw new Error("no write");
      },
    },
    {
      async lookup() {
        throw new Error("no quota");
      },
      async reserve() {
        throw new Error("no quota");
      },
      async release() {},
      async settle() {},
    },
    {
      async create() {
        throw new Error("no provider I/O");
      },
      async findAttempt() {
        return { kind: "unknown" };
      },
      async inspect() {
        return null;
      },
      async leave() {
        return "accepted";
      },
    },
    "https://fixture.example/webhooks",
  );
  async function seed(count: number) {
    return repository.scoped(actor.workspaceId, async (tx) => {
      const rows = [];
      for (let index = 0; index < count; index++) {
        const row = await tx.insert({
          actor,
          context: {
            meetingId,
            ownerId: actor.actorId,
            version: 1,
            joinUrl: "https://meet.google.com/abc-defg-hij?secret=not-exported",
          },
          maxSeconds: 120,
        });
        rows.push(
          await tx.update(row.id, { state: "complete", quotaState: "settled", providerDone: true }),
        );
      }
      return rows;
    });
  }
  return {
    actor,
    meetingId,
    service,
    seed,
    set permitted(value: boolean) {
      permitted = value;
    },
    set revokeAfterFirst(value: boolean) {
      revokeAfterFirst = value;
    },
  };
}

test("database export manifest includes exactly100 captures and rejects101 while public list remains unchanged", async () => {
  const f = fixture(),
    rows = await f.seed(100);
  const manifest = await f.service.exportCaptures(f.actor, f.meetingId);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.captures.length, 100);
  assert.deepEqual(
    new Set(manifest.captures.map((row) => row.id)),
    new Set(rows.map((row) => row.id)),
  );
  assert.deepEqual(Object.keys(manifest.captures[0]!).sort(), [
    "coverage",
    "id",
    "state",
    "version",
  ]);
  await f.seed(1);
  await assert.rejects(
    f.service.exportCaptures(f.actor, f.meetingId),
    /CAPTURE_EXPORT_SCOPE_TOO_LARGE/,
  );
  assert.equal((await f.service.list(f.actor, f.meetingId)).length, 100);
  assert.deepEqual(
    await repository.scoped(randomUUID(), (tx) => tx.exportCaptures(f.meetingId)),
    [],
  );
});

test("empty export is complete only with current readable context and revocation after lookup blocks publication", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.exportCaptures(f.actor, f.meetingId), {
    meetingId: f.meetingId,
    complete: true,
    captures: [],
  });
  await assert.rejects(
    f.service.exportCaptures({ ...f.actor, actorId: randomUUID() }, f.meetingId),
    /FORBIDDEN/,
  );
  const revoked = fixture();
  await revoked.seed(1);
  revoked.revokeAfterFirst = true;
  await assert.rejects(
    revoked.service.exportCaptures(revoked.actor, revoked.meetingId),
    /FORBIDDEN/,
  );
});

test("signed native export endpoint pins Reporting and rejects tenant/operation/caller mismatch", async () => {
  const f = fixture();
  await f.seed(1);
  const keys = await generateKeyPair("EdDSA"),
    publicKey = { ...(await exportJWK(keys.publicKey)), kid: "export-fixture" };
  const identity = new ServiceIdentity("ingest", { reporting: [publicKey] });
  const app = ingestApp(
    f.service,
    async () => f.actor,
    new RecallSignatures([`whsec_${Buffer.alloc(32, 1).toString("base64")}`]),
    undefined,
    undefined,
    undefined,
    undefined,
    async (token) => (await identity.verify(token)).actor,
  );
  const path = `/internal/workspaces/${f.actor.workspaceId}/meetings/${f.meetingId}/export-captures`;
  const auth = async (caller: "reporting" | "gateway" | "intelligence", actor = f.actor) =>
    `Bearer ${await serviceToken({ caller, audience: "ingest", actor, privateKey: keys.privateKey, keyId: "export-fixture" })}`;
  try {
    const result = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: await auth("reporting") },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().complete, true);
    for (const caller of ["gateway", "intelligence"] as const) {
      const rejected = await app.inject({
        method: "GET",
        url: path,
        headers: { authorization: await auth(caller) },
      });
      assert.equal(rejected.statusCode, 401);
    }
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: path.replace(f.actor.workspaceId, randomUUID()),
          headers: { authorization: await auth("reporting") },
        })
      ).statusCode,
      403,
    );
    const grantId = randomUUID();
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: path,
          headers: {
            authorization: await auth("reporting", {
              ...f.actor,
              operationGrantId: grantId,
              sessionId: `operation:${grantId}`,
            }),
          },
        })
      ).statusCode,
      403,
    );
    f.permitted = false;
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: path,
          headers: { authorization: await auth("reporting") },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

test("owning deletion barrier forbids exporting capture metadata even if a remote read projection is stale", async () => {
  const f = fixture();
  await f.seed(1);
  await repository.scoped(f.actor.workspaceId, (tx) =>
    tx.deleteMeeting(f.meetingId, randomUUID(), 1),
  );
  await assert.rejects(f.service.exportCaptures(f.actor, f.meetingId), /SOURCE_DELETED/);
});
