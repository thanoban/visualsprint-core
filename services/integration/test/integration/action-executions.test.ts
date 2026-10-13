import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  AppError,
  type Actor,
} from "@visualsprint/platform";
import { PostgresActionExecutions } from "../../src/infrastructure/action-store.js";
import { AesTokenVault } from "../../src/infrastructure/vault.js";
import {
  ActionExecutions,
  actionFingerprint,
  type ExecutionIntent,
  type ActionProvider,
} from "../../src/application/action-executions.js";
const migration = databasePool(
    "postgres://vs_integration_migration:local-migration-only@127.0.0.1:55437/integration",
    1,
  ),
  pool = databasePool(
    "postgres://vs_integration_runtime:local-runtime-only@127.0.0.1:55437/integration",
    3,
  ),
  store = new PostgresActionExecutions(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function fixture(unknown = false) {
  const actor: Actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "session" },
    vault = new AesTokenVault("test", { test: randomBytes(32).toString("base64") }),
    proofs = new Map<string, ExecutionIntent>();
  let active = true,
    calls = 0,
    proofValid = true,
    matched = true;
  const provider: ActionProvider = {
    async create(_c, credential) {
      assert.equal(credential, "fixture-private-token");
      calls++;
      return unknown ? { state: "unknown" } : { state: "confirmed", externalId: "42" };
    },
    async verify() {
      return matched;
    },
    async status(_c, _credential, externalId) {
      return { externalId, state: "open", status: "open", updatedAt: "2026-10-13T00:00:00Z" };
    },
  };
  const approval = {
    async proof(principal: Actor, operationId: string) {
      if (!proofValid || principal.actorId !== actor.actorId) throw new AppError("FORBIDDEN", 403);
      const proof = proofs.get(operationId);
      if (!proof) throw new AppError("NOT_FOUND", 404);
      return proof;
    },
    async reference(principal: Actor, operationId: string) {
      return this.proof(principal, operationId);
    },
  };
  const service = new ActionExecutions(
    store,
    {
      async requireActive() {
        if (!active) throw new AppError("FORBIDDEN", 403);
      },
    },
    approval,
    vault,
    provider,
  );
  const configured = await service.configure(actor, "connector-command-1", {
    provider: "github",
    repository: "example/customer",
    credential: "fixture-private-token",
  });
  const intent = () => {
    const draft = {
      connectionId: configured.id,
      provider: "github" as const,
      destination: "example/customer",
      payload: { title: "Reviewed task", description: "Exact reviewed description", dueDate: null },
      source: { meetingId: randomUUID(), revision: 1 },
    };
    const input = {
      operationId: randomUUID(),
      approvalId: randomUUID(),
      payloadHash: actionFingerprint(draft),
      ...draft,
    };
    proofs.set(input.operationId, input);
    return input;
  };
  return {
    actor,
    service,
    configured,
    intent,
    proofs,
    vault,
    calls: () => calls,
    revoke: () => {
      active = false;
    },
    denyProof: () => {
      proofValid = false;
    },
    mismatch: () => {
      matched = false;
    },
  };
}
test("encrypted private connectors and exact approved execution are durable/idempotent", async () => {
  const f = await fixture();
  const c = await store.connection(f.actor.workspaceId, f.configured.id);
  assert.ok(c?.credentialCipher);
  assert.equal(c.credentialCipher.includes("fixture-private-token"), false);
  assert.equal(JSON.stringify(await f.service.list(f.actor)).includes("credential"), false);
  assert.deepEqual(await f.service.list({ ...f.actor, actorId: randomUUID() }), []);
  const input = f.intent();
  const result = await f.service.execute(f.actor, input);
  assert.deepEqual(result, { state: "confirmed", externalId: "42" });
  await f.service.execute(f.actor, input);
  assert.equal(f.calls(), 1);
  assert.deepEqual(await f.service.taskStatus(f.actor, input.operationId), {
    operationId: input.operationId,
    externalId: "42",
    state: "open",
    status: "open",
    updatedAt: "2026-10-13T00:00:00Z",
  });
  await assert.rejects(
    f.service.execute(f.actor, { ...input, payload: { ...input.payload, title: "Altered" } }),
    (e) => e instanceof AppError && e.code === "APPROVAL_PAYLOAD_MISMATCH",
  );
  assert.equal(await store.get(randomUUID(), input.operationId), undefined);
});
test("ambiguous/crashed dispatch stays lookup-only and never repeats create", async () => {
  const f = await fixture(true),
    input = f.intent();
  assert.deepEqual(await f.service.execute(f.actor, input), { state: "unknown" });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await f.service.execute(f.actor, input), { state: "unknown" });
    assert.deepEqual(await f.service.reconcile(f.actor, input.operationId, input), {
      state: "unknown",
    });
  }
  assert.equal(f.calls(), 1);
  const second = f.intent(),
    c = (await store.connection(f.actor.workspaceId, f.configured.id))!;
  const prepared = await store.prepare(f.actor, second, c);
  await store.claim(prepared);
  await f.service.execute(f.actor, second);
  assert.equal(f.calls(), 1);
  f.revoke();
  assert.deepEqual(await f.service.reconcile(f.actor, input.operationId, input), {
    state: "unknown",
  });
  await assert.rejects(
    f.service.execute(f.actor, input),
    (e) => e instanceof AppError && e.status === 403,
  );
});
test("reference confirmation is exact, owner authorized and cannot bind one external issue twice", async () => {
  const f = await fixture(true),
    first = f.intent(),
    second = f.intent();
  await f.service.execute(f.actor, first);
  await f.service.execute(f.actor, second);
  assert.deepEqual(
    await f.service.reference(f.actor, first.operationId, { externalId: "42", confirmed: true }),
    { state: "confirmed", externalId: "42" },
  );
  await assert.rejects(
    f.service.reference(f.actor, second.operationId, { externalId: "42", confirmed: true }),
    (e) => e instanceof AppError && e.code === "EXTERNAL_REFERENCE_ALREADY_BOUND",
  );
  f.mismatch();
  await assert.rejects(
    f.service.reference(f.actor, second.operationId, { externalId: "43", confirmed: true }),
    (e) => e instanceof AppError && e.code === "ACTION_REFERENCE_MISMATCH",
  );
  f.denyProof();
  await assert.rejects(
    f.service.reference(f.actor, second.operationId, { externalId: "43", confirmed: true }),
    (e) => e instanceof AppError && e.status === 403,
  );
});
test("disconnect fences writes and deletion purges payload yet preserves late external cleanup evidence", async () => {
  const f = await fixture(true),
    input = f.intent(),
    c = (await store.connection(f.actor.workspaceId, f.configured.id))!,
    prepared = await store.prepare(f.actor, input, c),
    claimed = await store.claim(prepared);
  assert.ok(claimed);
  const deletionId = randomUUID(),
    body = { meetingId: input.source.meetingId, sourceVersion: 2 };
  const ack = await f.service.delete(f.actor, deletionId, body);
  assert.equal(ack.state, "complete");
  assert.equal(ack.externalCleanup, "pending");
  await store.finish(claimed, { state: "confirmed", externalId: "99" });
  const deleted = await store.get(f.actor.workspaceId, input.operationId);
  assert.equal(deleted?.state, "deleted");
  assert.equal(deleted?.payload, null);
  assert.equal(deleted?.externalId, "99");
  await assert.rejects(
    f.service.execute(f.actor, input),
    (e) => e instanceof AppError && e.status === 404,
  );
  await assert.rejects(
    f.service.delete(f.actor, deletionId, { ...body, meetingId: randomUUID() }),
    (e) => e instanceof AppError && e.code === "DELETION_TARGET_CONFLICT",
  );
  await f.service.disconnect(f.actor, c.id, { expectedVersion: 1 });
  assert.equal((await store.connection(f.actor.workspaceId, c.id))?.credentialCipher, null);
  await assert.rejects(
    f.service.execute(f.actor, f.intent()),
    (e) => e instanceof AppError && e.code === "ACTION_CONNECTION_UNAVAILABLE",
  );
});
