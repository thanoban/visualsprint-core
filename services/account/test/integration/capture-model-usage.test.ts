// Draft qualification: do not invoke until the owner restores local Docker/PostgreSQL test availability.
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
import { AccountService } from "../../src/application/account.js";
import { PostgresAccount } from "../../src/infrastructure/store.js";
import { CaptureConsentService } from "../../src/application/capture-consent.js";
import { PostgresCaptureConsents } from "../../src/infrastructure/capture-consent-store.js";
import {
  CaptureModelUsageService,
  type CaptureModelRequest,
} from "../../src/application/capture-model-usage.js";
import { PostgresCaptureModelUsage } from "../../src/infrastructure/capture-model-store.js";
import { ModelUsageService } from "../../src/application/model-usage.js";
import { PostgresModelUsage } from "../../src/infrastructure/model-usage-store.js";
const migration = databasePool(
    "postgres://vs_account_migration:local-migration-only@127.0.0.1:55434/account",
    1,
  ),
  runtime = databasePool(
    "postgres://vs_account_runtime:local-runtime-only@127.0.0.1:55434/account",
    5,
  );
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(runtime);
});
after(async () => {
  await migration.end();
  await runtime.end();
});
const accounts = new AccountService(new PostgresAccount(runtime), "dev-cell");
async function scoped<T>(
  pool: typeof runtime,
  workspaceId: string,
  work: (db: import("pg").PoolClient) => Promise<T>,
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function fixture() {
  const identity = {
      subject: "user_CaptureModel" + randomUUID().replaceAll("-", ""),
      sessionId: randomUUID(),
    },
    user = await accounts.me(identity),
    workspace = await accounts.createWorkspace(identity, randomUUID(), {
      name: "Capture model qualification",
    }),
    owner: Actor = {
      workspaceId: workspace.id,
      actorId: user.userId,
      sessionId: identity.sessionId,
    },
    meetingId = randomUUID(),
    captureId = randomUUID();
  let readyCalls = 0,
    afterReady = async () => {};
  const consents = new CaptureConsentService(new PostgresCaptureConsents(runtime), {
    async read(a, id) {
      if (a.actorId !== owner.actorId || id !== captureId) throw new AppError("FORBIDDEN", 403);
      return {
        captureId,
        meetingId,
        ownerId: owner.actorId,
        policyVersion: "english-text-v1",
        optedIn: true,
      };
    },
  });
  const grant = await consents.create(owner, randomUUID(), {
    captureId,
    consent: true,
    policyVersion: "english-text-v1",
  });
  const actor = {
    ...owner,
    operationGrantId: grant.consentId,
    sessionId: `operation:${grant.consentId}`,
  };
  const body: CaptureModelRequest = {
    operationId: randomUUID(),
    purpose: "capture_extraction",
    proof: {
      consentId: grant.consentId,
      expectedVersion: grant.version,
      meetingId,
      captureId,
      policyVersion: "english-text-v1",
    },
    transcriptRevision: 3,
    maxInputTokens: 1000,
    maxOutputTokens: 100,
  };
  const repository = new PostgresCaptureModelUsage(runtime),
    readiness = {
      async assertReady() {
        readyCalls++;
        await afterReady();
      },
    };
  return {
    identity,
    owner,
    actor,
    grant,
    body,
    consents,
    repository,
    readiness,
    service: new CaptureModelUsageService(repository, readiness, true),
    get readyCalls() {
      return readyCalls;
    },
    set afterReady(value: () => Promise<void>) {
      afterReady = value;
    },
  };
}
async function policy(ws: string, concurrency = 2) {
  await scoped(migration, ws, async (db) => {
    await db.query(
      "INSERT INTO model_entitlements(workspace_id,purpose) VALUES($1,'capture_extraction') ON CONFLICT DO NOTHING",
      [ws],
    );
    await db.query(
      "UPDATE model_entitlements SET max_concurrent=$2,monthly_input_tokens=100000,monthly_output_tokens=10000 WHERE workspace_id=$1 AND purpose='capture_extraction'",
      [ws, concurrency],
    );
  });
}
test("capture-specific default budget is zero and exact parallel reservations admit one paid intent", async () => {
  const f = await fixture();
  await assert.rejects(f.service.reserve(f.actor, f.body), /MODEL_CONCURRENCY_LIMIT/);
  const beforeCalls = f.readyCalls;
  for (const proof of [
    { ...f.body.proof, captureId: randomUUID() },
    { ...f.body.proof, meetingId: randomUUID() },
    { ...f.body.proof, expectedVersion: 2 },
  ])
    await assert.rejects(f.service.reserve(f.actor, { ...f.body, proof }), /FORBIDDEN/);
  assert.equal(f.readyCalls, beforeCalls);
  await policy(f.actor.workspaceId, 2);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => f.service.reserve(f.actor, f.body)),
  );
  assert.equal(new Set(results.map((r) => r.reservationId)).size, 1);
  assert.equal(results.filter((r) => !r.replay).length, 1);
  await assert.rejects(
    f.service.reserve(f.actor, { ...f.body, maxInputTokens: 1001 }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    f.service.reserve(f.actor, { ...f.body, transcriptRevision: 4 }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await scoped(runtime, f.actor.workspaceId, async (db) => {
    assert.equal(
      (
        await db.query("SELECT * FROM capture_model_bindings WHERE operation_id=$1", [
          f.body.operationId,
        ])
      ).rowCount,
      1,
    );
  });
});
test("live consent/deletion/membership is rechecked after readiness and source preflight creates no reservation", async () => {
  const f = await fixture();
  await policy(f.actor.workspaceId);
  f.afterReady = async () => {
    await f.consents.revoke(f.owner, randomUUID(), f.grant.consentId, { expectedVersion: 1 });
  };
  await assert.rejects(f.service.reserve(f.actor, f.body), /FORBIDDEN/);
  assert.equal(f.readyCalls, 1);
  await scoped(runtime, f.actor.workspaceId, async (db) =>
    assert.equal(
      (
        await db.query("SELECT * FROM model_reservations WHERE operation_id=$1", [
          f.body.operationId,
        ])
      ).rowCount,
      0,
    ),
  );
  const g = await fixture();
  await policy(g.actor.workspaceId);
  g.afterReady = async () => {
    await scoped(migration, g.actor.workspaceId, (db) =>
      db.query("UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2", [
        g.actor.workspaceId,
        g.actor.actorId,
      ]),
    );
  };
  await assert.rejects(g.service.reserve(g.actor, g.body), /FORBIDDEN/);
});
test("consent survives normal logout but cleanup after revoke/disable has exact scope and unknown remains held", async () => {
  const f = await fixture();
  await policy(f.actor.workspaceId, 1);
  await accounts.logout(f.identity);
  const reservation = await f.service.reserve(f.actor, f.body);
  assert.equal(reservation.replay, false);
  await scoped(migration, f.actor.workspaceId, (db) =>
    db.query(
      "UPDATE capture_processing_consents SET active=false,version=version+1 WHERE workspace_id=$1 AND consent_id=$2",
      [f.actor.workspaceId, f.grant.consentId],
    ),
  );
  const calls = f.readyCalls,
    disabled = new CaptureModelUsageService(f.repository, f.readiness, false);
  assert.equal(
    (
      await disabled.record(f.actor, reservation.reservationId, {
        operationId: f.body.operationId,
        outcome: "unknown",
      })
    ).state,
    "unknown",
  );
  await assert.rejects(
    disabled.record(f.actor, reservation.reservationId, {
      operationId: f.body.operationId,
      outcome: "not_started",
    }),
    /MODEL_OUTCOME_CONFLICT/,
  );
  assert.equal(
    (
      await disabled.record(f.actor, reservation.reservationId, {
        operationId: f.body.operationId,
        outcome: "succeeded",
      })
    ).state,
    "succeeded",
  );
  await disabled.record(f.actor, reservation.reservationId, {
    operationId: f.body.operationId,
    outcome: "succeeded",
  });
  assert.equal(f.readyCalls, calls);
  await scoped(runtime, f.actor.workspaceId, async (db) =>
    assert.equal(
      (
        await db.query("SELECT * FROM model_estimate_ledger WHERE reservation_id=$1", [
          reservation.reservationId,
        ])
      ).rowCount,
      1,
    ),
  );
});
test("RLS, operator-owned policy and generic model APIs cannot widen capture authority", async () => {
  const f = await fixture();
  await policy(f.actor.workspaceId);
  const reservation = await f.service.reserve(f.actor, f.body);
  assert.equal(
    (
      await runtime.query("SELECT * FROM capture_model_bindings WHERE reservation_id=$1", [
        reservation.reservationId,
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(
    scoped(runtime, f.actor.workspaceId, (db) =>
      db.query(
        "UPDATE model_entitlements SET max_concurrent=100 WHERE workspace_id=$1 AND purpose='capture_extraction'",
        [f.actor.workspaceId],
      ),
    ),
    /permission denied/,
  );
  await assert.rejects(
    new ModelUsageService(new PostgresModelUsage(runtime)).record(
      f.owner,
      reservation.reservationId,
      { outcome: "not_started" },
    ),
    /FORBIDDEN/,
  );
  const wrongConsent = randomUUID();
  await assert.rejects(
    f.service.record(
      { ...f.actor, operationGrantId: wrongConsent, sessionId: `operation:${wrongConsent}` },
      reservation.reservationId,
      { operationId: f.body.operationId, outcome: "unknown" },
    ),
    /NOT_FOUND/,
  );
  await assert.rejects(
    f.service.record(f.actor, reservation.reservationId, {
      operationId: randomUUID(),
      outcome: "unknown",
    }),
    /NOT_FOUND/,
  );
  await assert.rejects(
    f.service.record({ ...f.actor, workspaceId: randomUUID() }, reservation.reservationId, {
      operationId: f.body.operationId,
      outcome: "unknown",
    }),
    /NOT_FOUND/,
  );
});
test("meeting deletion fences future capture admission while uncertain spend cleanup remains source-free", async () => {
  const f = await fixture();
  await policy(f.actor.workspaceId);
  const reservation = await f.service.reserve(f.actor, f.body);
  await f.consents.cleanup(f.actor.workspaceId, randomUUID(), {
    meetingId: f.body.proof.meetingId,
    sourceVersion: 2,
  });
  const calls = f.readyCalls;
  await assert.rejects(
    f.service.reserve(f.actor, { ...f.body, operationId: randomUUID() }),
    /FORBIDDEN/,
  );
  assert.equal(f.readyCalls, calls);
  await f.service.record(f.actor, reservation.reservationId, {
    operationId: f.body.operationId,
    outcome: "unknown",
  });
  assert.equal(f.readyCalls, calls);
});
