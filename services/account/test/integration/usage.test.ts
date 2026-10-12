import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  databasePool,
  migrate,
  ServiceIdentity,
  serviceToken,
  type Actor,
} from "@visualsprint/platform";
import { exportJWK, generateKeyPair } from "jose";
import { AccountService } from "../../src/application/account.js";
import { PostgresAccount } from "../../src/infrastructure/store.js";
import { accountApp } from "../../src/http/app.js";

const migration = databasePool(
  "postgres://vs_account_migration:local-migration-only@127.0.0.1:55434/account",
  1,
);
const runtime = databasePool(
  "postgres://vs_account_runtime:local-runtime-only@127.0.0.1:55434/account",
  4,
);
const account = new AccountService(new PostgresAccount(runtime), "dev-cell");
before(() => migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url))));
after(async () => {
  await runtime.end();
  await migration.end();
});
async function owner() {
  const identity = { subject: `user_${randomUUID().replaceAll("-", "")}`, sessionId: randomUUID() };
  const user = await account.me(identity);
  const workspace = await account.createWorkspace(identity, randomUUID(), {
    name: "Usage qualification",
  });
  return {
    identity,
    actor: {
      actorId: user.userId,
      workspaceId: workspace.id,
      sessionId: identity.sessionId,
    } satisfies Actor,
  };
}
test("concurrent reserve retries debit once and atomically cap five active meetings", async () => {
  const { actor } = await owner();
  const requestId = randomUUID();
  const duplicate = await Promise.all(
    Array.from({ length: 6 }, () =>
      account.reserveCapture(actor, { requestId, maxSeconds: 14400 }),
    ),
  );
  assert.equal(
    duplicate.every((record) => record.requestId === requestId && record.state === "held"),
    true,
  );
  await assert.rejects(account.reserveCapture(actor, { requestId, maxSeconds: 1000 }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      account.reserveCapture(actor, { requestId: randomUUID(), maxSeconds: 14400 }),
    ),
  );
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 4);
  assert.equal(
    attempts.filter(
      (attempt) => attempt.status === "rejected" && attempt.reason.code === "CONCURRENCY_LIMIT",
    ).length,
    4,
  );
  assert.equal((await runtime.query("SELECT * FROM capture_reservations")).rowCount, 0);
  await account.settleCapture(actor, { requestId, confirmedNoCapture: true }, true);
  await account.settleCapture(actor, { requestId, confirmedNoCapture: true }, true);
  assert.equal(
    (await account.reserveCapture(actor, { requestId: randomUUID(), maxSeconds: 14400 })).state,
    "held",
  );
});
test("actual usage is append-only, retries do not charge twice and cleanup survives session revocation", async () => {
  const { actor, identity } = await owner();
  const requestId = randomUUID();
  await account.reserveCapture(actor, { requestId, maxSeconds: 14400 });
  // Billing records actual measured usage, including an overrun; quota never erases costs.
  const settled = await account.settleCapture(actor, { requestId, seconds: 360000 });
  assert.equal(settled.chargedSeconds, 360000);
  assert.deepEqual(await account.settleCapture(actor, { requestId, seconds: 360000 }), settled);
  await assert.rejects(account.settleCapture(actor, { requestId, seconds: 1 }), {
    code: "RESERVATION_CONFLICT",
  });
  await assert.rejects(account.reserveCapture(actor, { requestId: randomUUID(), maxSeconds: 1 }), {
    code: "QUOTA_EXCEEDED",
  });
  const nextOwner = await owner();
  const pending = randomUUID();
  await account.reserveCapture(nextOwner.actor, { requestId: pending, maxSeconds: 1000 });
  await account.logout(nextOwner.identity);
  assert.equal(
    (await account.settleCapture(nextOwner.actor, { requestId: pending, seconds: 12 })).state,
    "settled",
  );
  await account.logout(identity);
  await assert.rejects(account.reserveCapture(actor, { requestId: randomUUID(), maxSeconds: 1 }), {
    code: "UNAUTHENTICATED",
  });
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [actor.workspaceId]);
    await assert.rejects(client.query("UPDATE entitlements SET monthly_seconds=999999999"), {
      code: "42501",
    });
    await client.query("ROLLBACK");
    await assert.rejects(client.query("DELETE FROM usage_ledger"), { code: "42501" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
test("only signed Ingest callers can reserve or settle; a trusted Workspace key cannot change membership", async () => {
  const { actor } = await owner();
  const keys = await generateKeyPair("EdDSA");
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "usage-test" };
  const app = accountApp(
    account,
    async () => {
      throw new Error("NO_USER_AUTH_IN_INTERNAL_TEST");
    },
    new ServiceIdentity("account", { workspace: [publicKey], ingest: [publicKey] }),
  );
  const token = (caller: string) =>
    serviceToken({
      caller,
      audience: "account",
      actor,
      privateKey: keys.privateKey,
      keyId: "usage-test",
    });
  try {
    const denied = await app.inject({
      method: "POST",
      url: `/internal/workspaces/${actor.workspaceId}/usage/reserve`,
      headers: { authorization: `Bearer ${await token("workspace")}` },
      payload: { requestId: randomUUID(), maxSeconds: 1000 },
    });
    assert.equal(denied.statusCode, 403);
    const accepted = await app.inject({
      method: "POST",
      url: `/internal/workspaces/${actor.workspaceId}/usage/reserve`,
      headers: { authorization: `Bearer ${await token("ingest")}` },
      payload: { requestId: randomUUID(), maxSeconds: 1000 },
    });
    assert.equal(accepted.statusCode, 200);
    const membership = await app.inject({
      method: "POST",
      url: `/internal/workspaces/${actor.workspaceId}/members`,
      headers: {
        authorization: `Bearer ${await token("workspace")}`,
        "idempotency-key": randomUUID(),
      },
      payload: { userId: actor.actorId, active: false, expectedVersion: 1 },
    });
    assert.equal(membership.statusCode, 403);
  } finally {
    await app.close();
  }
});
