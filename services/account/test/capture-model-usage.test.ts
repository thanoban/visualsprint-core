import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { AppError, ServiceIdentity, serviceToken, type Actor } from "@visualsprint/platform";
import {
  CaptureModelUsageService,
  captureModelFingerprint,
  type CaptureModelRequest,
  type CaptureModelRepository,
  type CaptureModelTransaction,
  type CaptureModelBinding,
} from "../src/application/capture-model-usage.js";
import type { ModelReservation, ModelBudget } from "../src/domain/model-usage.js";
import { ModelUsageService } from "../src/application/model-usage.js";
import { IngestCaptureModelReadiness } from "../src/infrastructure/capture-model-readiness.js";
import { accountApp } from "../src/http/app.js";
import type { AccountService } from "../src/application/account.js";
function fixture() {
  const consentId = randomUUID(),
    actor: Actor = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      sessionId: `operation:${consentId}`,
      operationGrantId: consentId,
    };
  const input: CaptureModelRequest = {
    operationId: randomUUID(),
    purpose: "capture_extraction",
    proof: {
      consentId,
      expectedVersion: 1,
      meetingId: randomUUID(),
      captureId: randomUUID(),
      policyVersion: "english-text-v1",
    },
    transcriptRevision: 3,
    maxInputTokens: 1000,
    maxOutputTokens: 100,
  };
  const reservations = new Map<string, ModelReservation>(),
    bindings = new Map<string, CaptureModelBinding>();
  let permitted = true,
    readyCalls = 0,
    recordCalls = 0,
    checks = 0,
    activeTransactions = 0,
    afterReady = async () => {},
    maxConcurrent = 2,
    tail: Promise<unknown> = Promise.resolve();
  const tx: CaptureModelTransaction = {
    async requireCurrent() {
      throw new Error("NORMAL_SESSION_CHECK_MUST_NOT_RUN");
    },
    async requireCapture() {
      checks++;
      if (!permitted) throw new AppError("FORBIDDEN", 403);
    },
    async lock() {},
    async budget() {
      return {
        maxConcurrent,
        monthlyInputTokens: 100000,
        monthlyOutputTokens: 10000,
        active: [...reservations.values()].filter((r) => ["held", "unknown"].includes(r.state))
          .length,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        consumedInputTokens: 0,
        consumedOutputTokens: 0,
      } satisfies ModelBudget;
    },
    async byOperation(operation) {
      return [...reservations.values()].find((r) => r.operationId === operation);
    },
    async reservation(id) {
      return reservations.get(id);
    },
    async create(body) {
      const reservation: ModelReservation = {
        ...body,
        reservationId: randomUUID(),
        workspaceId: actor.workspaceId,
        ownerId: actor.actorId,
        period: "2026-10-01",
        state: "held",
      };
      reservations.set(reservation.reservationId, reservation);
      return reservation;
    },
    async record(current, outcome) {
      recordCalls++;
      const updated = { ...current, state: outcome };
      reservations.set(current.reservationId, updated);
      return updated;
    },
    async binding(id) {
      return bindings.get(id);
    },
    async bind(id, body) {
      bindings.set(id, {
        reservationId: id,
        operationId: body.operationId,
        ownerId: actor.actorId,
        consentId: body.proof.consentId,
        fingerprint: captureModelFingerprint(body),
      });
    },
  };
  const repository: CaptureModelRepository = {
    transaction(_actor, work) {
      const next = tail.then(async () => {
        activeTransactions++;
        try {
          return await work(tx);
        } finally {
          activeTransactions--;
        }
      });
      tail = next.catch(() => {});
      return next;
    },
  };
  const readiness = {
    async assertReady() {
      readyCalls++;
      await afterReady();
    },
  };
  return {
    actor,
    input,
    repository,
    readiness,
    reservations,
    service: new CaptureModelUsageService(repository, readiness, true),
    get readyCalls() {
      return readyCalls;
    },
    get recordCalls() {
      return recordCalls;
    },
    get checks() {
      return checks;
    },
    get activeTransactions() {
      return activeTransactions;
    },
    set permitted(v: boolean) {
      permitted = v;
    },
    set afterReady(v: () => Promise<void>) {
      afterReady = v;
    },
    set maxConcurrent(v: number) {
      maxConcurrent = v;
    },
  };
}
test("automatic capture budget admission is separately default-disabled and does not call source while disabled", async () => {
  const f = fixture();
  await assert.rejects(
    new CaptureModelUsageService(f.repository, f.readiness).reserve(f.actor, f.input),
    /CAPTURE_MODEL_ADMISSION_NOT_CONFIGURED/,
  );
  assert.equal(f.readyCalls, 0);
  assert.equal(f.reservations.size, 0);
});
test("only exact consent operation actor and capture-specific purpose can reserve; limits are bounded", async () => {
  const f = fixture();
  for (const actor of [
    { ...f.actor, operationGrantId: undefined },
    { ...f.actor, sessionId: "normal-user-session" },
    { ...f.actor, operationGrantId: randomUUID() },
  ])
    await assert.rejects(f.service.reserve(actor, f.input), /FORBIDDEN/);
  for (const update of [
    { purpose: "summary" },
    { maxInputTokens: 250001 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 6001 },
  ])
    await assert.rejects(f.service.reserve(f.actor, { ...f.input, ...update }));
  assert.equal(f.readyCalls, 0);
});
test("exact operation replay returns one fresh reservation and changed source/estimate conflicts", async () => {
  const f = fixture();
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => f.service.reserve(f.actor, f.input)),
  );
  assert.equal(new Set(responses.map((r) => r.reservationId)).size, 1);
  assert.equal(responses.filter((r) => !r.replay).length, 1);
  for (const update of [
    { maxInputTokens: 1001 },
    { transcriptRevision: 4 },
    { proof: { ...f.input.proof, expectedVersion: 2 } },
  ])
    await assert.rejects(
      f.service.reserve(f.actor, { ...f.input, ...update }),
      /IDEMPOTENCY_CONFLICT/,
    );
});
test("source callback is outside transactions and revoked grant is checked again before reservation", async () => {
  const f = fixture();
  f.afterReady = async () => {
    assert.equal(f.activeTransactions, 0);
    f.permitted = false;
  };
  await assert.rejects(f.service.reserve(f.actor, f.input), /FORBIDDEN/);
  assert.equal(f.readyCalls, 1);
  assert.equal(f.reservations.size, 0);
  const g = fixture();
  g.permitted = false;
  await assert.rejects(g.service.reserve(g.actor, g.input), /FORBIDDEN/);
  assert.equal(g.readyCalls, 0);
});
test("zero capture-purpose budget fails closed without borrowing interactive quota", async () => {
  const f = fixture();
  f.maxConcurrent = 0;
  await assert.rejects(f.service.reserve(f.actor, f.input), /MODEL_CONCURRENCY_LIMIT/);
  assert.equal(f.reservations.size, 0);
  await assert.rejects(
    new ModelUsageService(f.repository).reserve(
      { ...f.actor, operationGrantId: undefined, sessionId: "normal" },
      {
        operationId: f.input.operationId,
        purpose: "capture_extraction",
        maxInputTokens: 1000,
        maxOutputTokens: 100,
      },
    ),
  );
});
test("cleanup after disabled feature/revocation is exact owner/consent/operation bound and makes no source calls", async () => {
  const f = fixture(),
    r = await f.service.reserve(f.actor, f.input),
    calls = f.readyCalls;
  f.permitted = false;
  const disabled = new CaptureModelUsageService(f.repository, f.readiness, false);
  const wrongConsent = randomUUID();
  for (const [actor, operationId] of [
    [{ ...f.actor, actorId: randomUUID() }, f.input.operationId],
    [{ ...f.actor, operationGrantId: randomUUID(), sessionId: "wrong" }, f.input.operationId],
    [
      { ...f.actor, operationGrantId: wrongConsent, sessionId: `operation:${wrongConsent}` },
      f.input.operationId,
    ],
    [f.actor, randomUUID()],
  ] as [Actor, string][])
    await assert.rejects(
      disabled.record(actor, r.reservationId, { operationId, outcome: "not_started" }),
    );
  assert.equal(
    (
      await disabled.record(f.actor, r.reservationId, {
        operationId: f.input.operationId,
        outcome: "unknown",
      })
    ).state,
    "unknown",
  );
  await assert.rejects(
    disabled.record(f.actor, r.reservationId, {
      operationId: f.input.operationId,
      outcome: "not_started",
    }),
    /MODEL_OUTCOME_CONFLICT/,
  );
  assert.equal(
    (
      await disabled.record(f.actor, r.reservationId, {
        operationId: f.input.operationId,
        outcome: "succeeded",
      })
    ).state,
    "succeeded",
  );
  await disabled.record(f.actor, r.reservationId, {
    operationId: f.input.operationId,
    outcome: "succeeded",
  });
  assert.equal(f.recordCalls, 2);
  assert.equal(f.readyCalls, calls);
});
test("generic normal-user cleanup cannot record a capture reservation", async () => {
  const f = fixture(),
    r = await f.service.reserve(f.actor, f.input);
  await assert.rejects(
    new ModelUsageService(f.repository).record(
      { ...f.actor, operationGrantId: undefined, sessionId: "normal" },
      r.reservationId,
      { outcome: "not_started" },
    ),
    /FORBIDDEN/,
  );
});
test("readiness adapter pins Account signature/target and rejects widened or mismatched metadata", async () => {
  const f = fixture(),
    key = await generateKeyPair("EdDSA"),
    jwk = { ...(await exportJWK(key.publicKey)), kid: "account-capture-test" },
    identity = new ServiceIdentity("ingest", { account: [jwk] });
  let change: Record<string, unknown> = {};
  const transport: typeof fetch = async (url, options) => {
    assert.equal(
      String(url),
      `https://ingest.internal.test/internal/workspaces/${f.actor.workspaceId}/captures/${f.input.proof.captureId}/processing-ready-context`,
    );
    assert.equal(options?.redirect, "error");
    const proof = await identity.verify(
      String(new Headers(options?.headers).get("authorization")).slice(7),
    );
    assert.equal(proof.actor.operationGrantId, f.input.proof.consentId);
    assert.deepEqual(JSON.parse(String(options?.body)), {
      proof: f.input.proof,
      transcriptRevision: f.input.transcriptRevision,
    });
    return Response.json({
      workspaceId: f.actor.workspaceId,
      captureId: f.input.proof.captureId,
      meetingId: f.input.proof.meetingId,
      ownerId: f.actor.actorId,
      consentId: f.input.proof.consentId,
      consentVersion: 1,
      policyVersion: "english-text-v1",
      transcriptRevision: 3,
      state: "partial",
      ready: true,
      ...change,
    });
  };
  const adapter = new IngestCaptureModelReadiness(
    "https://ingest.internal.test",
    key.privateKey,
    "account-capture-test",
    transport,
  );
  await adapter.assertReady(f.actor, f.input);
  for (const mutation of [
    { ownerId: randomUUID() },
    { transcriptRevision: 4 },
    { text: "must never enter Account" },
  ]) {
    change = mutation;
    await assert.rejects(adapter.assertReady(f.actor, f.input), /CAPTURE_MODEL_SOURCE/);
  }
  for (const origin of [
    "https://user:pass@ingest.test",
    "https://ingest.test/path",
    "http://untrusted.test",
  ])
    assert.throws(
      () => new IngestCaptureModelReadiness(origin, key.privateKey, "account-capture-test"),
    );
});
test("native Account HTTP dedicated capture route pins Intelligence and generic route rejects operation actors", async () => {
  const f = fixture(),
    keys = await generateKeyPair("EdDSA"),
    jwk = { ...(await exportJWK(keys.publicKey)), kid: "intel-capture-test" };
  const app = accountApp(
    {} as AccountService,
    async () => {
      throw new Error("USER_ROUTE_NOT_USED");
    },
    new ServiceIdentity("account", { intelligence: [jwk], workspace: [jwk] }),
    new ModelUsageService(f.repository),
    undefined,
    f.service,
  );
  const sign = (caller: string, actor: Actor = f.actor) =>
      serviceToken({
        caller,
        audience: "account",
        actor,
        privateKey: keys.privateKey,
        keyId: "intel-capture-test",
      }),
    path = `/internal/workspaces/${f.actor.workspaceId}/capture-processing/model-usage/reservations`;
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${await sign("intelligence")}` },
          payload: f.input,
        })
      ).statusCode,
      200,
    );
    for (const [caller, actor] of [
      ["workspace", f.actor],
      ["intelligence", { ...f.actor, sessionId: "normal-session", operationGrantId: undefined }],
      ["intelligence", { ...f.actor, workspaceId: randomUUID() }],
    ] as [string, Actor][])
      assert.notEqual(
        (
          await app.inject({
            method: "POST",
            url: path,
            headers: { authorization: `Bearer ${await sign(caller, actor)}` },
            payload: f.input,
          })
        ).statusCode,
        200,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/internal/workspaces/${f.actor.workspaceId}/model-usage/reservations`,
          headers: { authorization: `Bearer ${await sign("intelligence")}` },
          payload: {
            operationId: randomUUID(),
            purpose: "summary",
            maxInputTokens: 1,
            maxOutputTokens: 1,
          },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
test("native disabled capture admission still permits source-free bound cleanup and returns no-store metadata", async () => {
  const f = fixture(),
    reservation = await f.service.reserve(f.actor, f.input),
    calls = f.readyCalls;
  f.permitted = false;
  const key = await generateKeyPair("EdDSA"),
    jwk = { ...(await exportJWK(key.publicKey)), kid: "capture-cleanup-disabled" };
  const app = accountApp(
    {} as AccountService,
    async () => {
      throw new Error("UNUSED_USER_ROUTE");
    },
    new ServiceIdentity("account", { intelligence: [jwk] }),
    undefined,
    undefined,
    new CaptureModelUsageService(f.repository, f.readiness, false),
  );
  const token = await serviceToken({
      caller: "intelligence",
      audience: "account",
      actor: f.actor,
      privateKey: key.privateKey,
      keyId: "capture-cleanup-disabled",
    }),
    root = `/internal/workspaces/${f.actor.workspaceId}/capture-processing/model-usage/reservations`;
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: root,
          headers: { authorization: `Bearer ${token}` },
          payload: f.input,
        })
      ).statusCode,
      503,
    );
    const result = await app.inject({
      method: "POST",
      url: `${root}/${reservation.reservationId}/record`,
      headers: { authorization: `Bearer ${token}` },
      payload: { operationId: f.input.operationId, outcome: "unknown" },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.deepEqual(result.json(), { reservationId: reservation.reservationId, state: "unknown" });
    assert.equal(f.readyCalls, calls);
  } finally {
    await app.close();
  }
});
