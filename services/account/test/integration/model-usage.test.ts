import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair } from "jose";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  ServiceIdentity,
  serviceToken,
  type Actor,
} from "@visualsprint/platform";
import { AccountService } from "../../src/application/account.js";
import { ModelUsageService } from "../../src/application/model-usage.js";
import { PostgresAccount } from "../../src/infrastructure/store.js";
import { PostgresModelUsage } from "../../src/infrastructure/model-usage-store.js";
import { accountApp } from "../../src/http/app.js";
import type { ModelPurpose } from "../../src/domain/model-usage.js";
const migration = databasePool(
    "postgres://vs_account_migration:local-migration-only@127.0.0.1:55434/account",
    1,
  ),
  runtime = databasePool(
    "postgres://vs_account_runtime:local-runtime-only@127.0.0.1:55434/account",
    5,
  );
const accounts = new AccountService(new PostgresAccount(runtime), "dev-cell"),
  repository = new PostgresModelUsage(runtime),
  models = new ModelUsageService(repository);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(runtime);
});
after(async () => {
  await runtime.end();
  await migration.end();
});
async function fixture() {
  const identity = {
    subject: "user_Model" + randomUUID().replaceAll("-", ""),
    sessionId: randomUUID(),
  };
  const user = await accounts.me(identity),
    workspace = await accounts.createWorkspace(identity, randomUUID(), {
      name: "Model usage qualification",
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
const request = (purpose: ModelPurpose = "preparation", input = 1000, output = 100) => ({
  operationId: randomUUID(),
  purpose,
  maxInputTokens: input,
  maxOutputTokens: output,
});
async function policy(
  actor: Actor,
  purpose: ModelPurpose,
  concurrent: number,
  input: number,
  output: number,
) {
  const client = await migration.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [actor.workspaceId]);
    await client.query(
      "INSERT INTO model_entitlements(workspace_id,purpose,max_concurrent,monthly_input_tokens,monthly_output_tokens) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,purpose) DO UPDATE SET max_concurrent=$3,monthly_input_tokens=$4,monthly_output_tokens=$5",
      [actor.workspaceId, purpose, concurrent, input, output],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
test("simultaneous exact reserve retries admit once; changed purpose/estimate/owner fails and no replay grants another call", async () => {
  const f = await fixture(),
    body = request();
  const responses = await Promise.all(
    Array.from({ length: 6 }, () => models.reserve(f.actor, body)),
  );
  assert.equal(new Set(responses.map((row) => row.reservationId)).size, 1);
  assert.equal(responses.filter((row) => !row.replay).length, 1);
  assert.equal(responses.filter((row) => row.replay).length, 5);
  await assert.rejects(
    models.reserve(f.actor, { ...body, maxInputTokens: 1001 }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    models.reserve(f.actor, { ...body, purpose: "summary" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const identity = {
      subject: "user_Other" + randomUUID().replaceAll("-", ""),
      sessionId: randomUUID(),
    },
    user = await accounts.me(identity);
  await accounts.changeMember(f.actor, randomUUID(), {
    userId: user.userId,
    active: true,
    expectedVersion: 0,
  });
  await assert.rejects(
    models.reserve({ ...f.actor, actorId: user.userId, sessionId: identity.sessionId }, body),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test("operator concurrency bounds race-safe admissions and independent chat quota survives batch saturation", async () => {
  const f = await fixture();
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => models.reserve(f.actor, request())),
  );
  assert.equal(results.filter((row) => row.status === "fulfilled").length, 2);
  for (const row of results)
    if (row.status === "rejected") assert.match(String(row.reason), /MODEL_CONCURRENCY_LIMIT/);
  assert.equal((await models.reserve(f.actor, request("chat"))).replay, false);
  await assert.rejects(
    repository.transaction(f.actor, async () => {
      const c = await runtime.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
        await c.query("UPDATE model_entitlements SET max_concurrent=100 WHERE workspace_id=$1", [
          f.actor.workspaceId,
        ]);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    }),
    /permission denied/,
  );
});
test("successful usage charges conservative estimates once; not-started releases safe capacity, unknown cannot", async () => {
  const f = await fixture();
  await policy(f.actor, "preparation", 2, 2000, 200);
  const first = await models.reserve(f.actor, request());
  await models.record(f.actor, first.reservationId, { outcome: "succeeded" });
  await models.record(f.actor, first.reservationId, { outcome: "succeeded" });
  let totals = await repository.transaction(f.actor, (tx) => tx.budget("preparation"));
  assert.equal(totals.consumedInputTokens, 1000);
  assert.equal(totals.consumedOutputTokens, 100);
  const second = await models.reserve(f.actor, request());
  await models.record(f.actor, second.reservationId, { outcome: "not_started" });
  const third = await models.reserve(f.actor, request());
  await models.record(f.actor, third.reservationId, { outcome: "unknown" });
  await models.record(f.actor, third.reservationId, { outcome: "unknown" });
  await assert.rejects(
    models.record(f.actor, third.reservationId, { outcome: "not_started" }),
    /MODEL_OUTCOME_CONFLICT/,
  );
  await assert.rejects(models.reserve(f.actor, request()), /MODEL_QUOTA_EXCEEDED/);
  totals = await repository.transaction(f.actor, (tx) => tx.budget("preparation"));
  assert.equal(totals.active, 1);
  assert.equal(totals.reservedInputTokens, 1000);
  await models.record(f.actor, third.reservationId, { outcome: "succeeded" });
  totals = await repository.transaction(f.actor, (tx) => tx.budget("preparation"));
  assert.equal(totals.active, 0);
  assert.equal(totals.consumedInputTokens, 2000);
  await assert.rejects(models.reserve(f.actor, request()), /MODEL_QUOTA_EXCEEDED/);
  await assert.rejects(
    models.record(f.actor, first.reservationId, { outcome: "unknown" }),
    /MODEL_OUTCOME_CONFLICT/,
  );
});
test("embedding bounds accept zero output tokens but reject counting vector dimensions as tokens", async () => {
  const f = await fixture();
  await policy(f.actor, "indexing", 2, 96000, 0);
  const reserved = await models.reserve(f.actor, request("indexing", 96000, 0));
  await models.record(f.actor, reserved.reservationId, { outcome: "succeeded" });
  const totals = await repository.transaction(f.actor, (tx) => tx.budget("indexing"));
  assert.equal(totals.consumedOutputTokens, 0);
  await assert.rejects(models.reserve(f.actor, request("indexing", 1000, 1536)));
  await assert.rejects(models.reserve(f.actor, request("indexing", 96001, 0)));
  await assert.rejects(models.reserve(f.actor, request("retrieval", 6001, 0)));
  await assert.rejects(models.reserve(f.actor, request("preparation", 1000, 0)));
  await assert.rejects(models.reserve(f.actor, { ...request(), actualInputTokens: 1 }));
});
test("member revocation blocks new admission but owner-only record cleanup still settles existing usage", async () => {
  const f = await fixture();
  const identity = {
    subject: "user_ModelMember" + randomUUID().replaceAll("-", ""),
    sessionId: randomUUID(),
  };
  const user = await accounts.me(identity);
  await accounts.changeMember(f.actor, randomUUID(), {
    userId: user.userId,
    active: true,
    expectedVersion: 0,
  });
  const member = { ...f.actor, actorId: user.userId, sessionId: identity.sessionId };
  const reserved = await models.reserve(member, request());
  await accounts.changeMember(f.actor, randomUUID(), {
    userId: user.userId,
    active: false,
    expectedVersion: 1,
  });
  await assert.rejects(models.reserve(member, request()), /FORBIDDEN/);
  await models.record(member, reserved.reservationId, { outcome: "succeeded" });
  await assert.rejects(
    models.record(f.actor, reserved.reservationId, { outcome: "succeeded" }),
    /NOT_FOUND/,
  );
});
test("unknown reservations do not expire across month boundaries and ledger history cannot be overwritten by runtime", async () => {
  const f = await fixture();
  await policy(f.actor, "preparation", 1, 2000, 200);
  const held = await models.reserve(f.actor, request());
  await models.record(f.actor, held.reservationId, { outcome: "unknown" });
  const operator = await migration.connect();
  try {
    await operator.query("BEGIN");
    await operator.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
    await operator.query(
      "UPDATE model_reservations SET period=(date_trunc('month',now() AT TIME ZONE 'UTC')-interval '1 month')::date,created_at=now()-interval '40 days' WHERE reservation_id=$1",
      [held.reservationId],
    );
    await operator.query("COMMIT");
  } catch (error) {
    await operator.query("ROLLBACK");
    throw error;
  } finally {
    operator.release();
  }
  const totals = await repository.transaction(f.actor, (tx) => tx.budget("preparation"));
  assert.equal(totals.active, 1);
  assert.equal(totals.reservedInputTokens, 0);
  await assert.rejects(models.reserve(f.actor, request()), /MODEL_CONCURRENCY_LIMIT/);
  await models.record(f.actor, held.reservationId, { outcome: "succeeded" });
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
    const booking = (
      await client.query(
        "SELECT period::text AS period FROM model_estimate_ledger WHERE reservation_id=$1",
        [held.reservationId],
      )
    ).rows[0];
    assert.match(String(booking.period), /^\d{4}-\d{2}-01$/);
    await assert.rejects(
      client.query(
        "UPDATE model_estimate_ledger SET estimated_input_tokens=1 WHERE reservation_id=$1",
        [held.reservationId],
      ),
      /permission denied/,
    );
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [f.actor.workspaceId]);
    await assert.rejects(
      client.query("DELETE FROM model_outcome_ledger WHERE reservation_id=$1", [
        held.reservationId,
      ]),
      /permission denied/,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
test("new reserve requires active original session; owner cleanup survives logout/revocation and never widens tenant access", async () => {
  const f = await fixture();
  const first = await models.reserve(f.actor, request());
  await accounts.logout(f.identity);
  await assert.rejects(models.reserve(f.actor, request()), /FORBIDDEN/);
  await models.record(f.actor, first.reservationId, { outcome: "unknown" });
  await models.record(f.actor, first.reservationId, { outcome: "succeeded" });
  await assert.rejects(
    models.record({ ...f.actor, actorId: randomUUID() }, first.reservationId, {
      outcome: "succeeded",
    }),
    /NOT_FOUND/,
  );
  await assert.rejects(
    models.record({ ...f.actor, workspaceId: randomUUID() }, first.reservationId, {
      outcome: "succeeded",
    }),
    /NOT_FOUND/,
  );
  assert.equal(
    (
      await runtime.query("SELECT * FROM model_reservations WHERE reservation_id=$1", [
        first.reservationId,
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(
    models.record({ ...f.actor, operationGrantId: randomUUID() }, first.reservationId, {
      outcome: "succeeded",
    }),
    /FORBIDDEN/,
  );
});
test("signed Intelligence alone can use model reservation/cleanup routes and workspace mismatch fails closed", async () => {
  const f = await fixture(),
    keys = await generateKeyPair("EdDSA"),
    jwk = await exportJWK(keys.publicKey);
  const app = accountApp(
    accounts,
    async () => f.identity,
    new ServiceIdentity("account", {
      intelligence: [{ ...jwk, kid: "intel" }],
      workspace: [{ ...jwk, kid: "ws" }],
    }),
    models,
  );
  const url = `/internal/workspaces/${f.actor.workspaceId}/model-usage/reservations`;
  const token = (caller: string, actor: Actor = f.actor) =>
    serviceToken({
      privateKey: keys.privateKey,
      caller,
      audience: "account",
      actor,
      keyId: caller === "intelligence" ? "intel" : "ws",
    });
  try {
    const wrong = await app.inject({
      method: "POST",
      url,
      headers: { authorization: "Bearer " + (await token("workspace")) },
      payload: request(),
    });
    assert.equal(wrong.statusCode, 403);
    const body = request(),
      response = await app.inject({
        method: "POST",
        url,
        headers: { authorization: "Bearer " + (await token("intelligence")) },
        payload: body,
      });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().replay, false);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: "Bearer " + (await token("intelligence")) },
          payload: body,
        })
      ).json().replay,
      true,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: {
            authorization:
              "Bearer " + (await token("intelligence", { ...f.actor, workspaceId: randomUUID() })),
          },
          payload: request(),
        })
      ).statusCode,
      403,
    );
    await accounts.logout(f.identity);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: url + `/${response.json().reservationId}/record`,
          headers: { authorization: "Bearer " + (await token("intelligence")) },
          payload: { outcome: "not_started" },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});
