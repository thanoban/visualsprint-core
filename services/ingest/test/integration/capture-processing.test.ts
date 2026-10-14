import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  databasePool,
  migrate,
  assertRuntimeRole,
  AppError,
  type Actor,
} from "@visualsprint/platform";
import { PostgresCapture } from "../../src/infrastructure/store.js";
import { PostgresCaptureProcessing } from "../../src/infrastructure/capture-processing-store.js";
import { CaptureService } from "../../src/application/capture-service.js";
import { ingestApp } from "../../src/http/app.js";
import { RecallSignatures } from "../../src/infrastructure/webhook-signature.js";
import {
  CaptureProcessingService,
  type ProcessingAuthority,
} from "../../src/application/capture-processing.js";
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
const captures = new PostgresCapture(pool),
  repository = new PostgresCaptureProcessing(pool);
before(async () => {
  await migrate(migration, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await assertRuntimeRole(pool);
});
after(async () => {
  await pool.end();
  await migration.end();
});
async function fixture() {
  const actor: Actor = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      sessionId: "normal-owner",
    },
    meetingId = randomUUID(),
    consentId = randomUUID();
  const capture = await captures.scoped(actor.workspaceId, (tx) =>
    tx.insert({
      actor,
      context: {
        meetingId,
        ownerId: actor.actorId,
        version: 1,
        joinUrl: "https://meet.google.com/abc-defg-hij",
      },
      maxSeconds: 120,
    }),
  );
  let permitted = true,
    withdrawUnavailable = false,
    grantCreated = false,
    beforeGrant: () => Promise<void> = async () => {};
  const grant = {
    consentId,
    workspaceId: actor.workspaceId,
    ownerId: actor.actorId,
    meetingId,
    captureId: capture.id,
    version: 1,
    policyVersion: "english-text-v1" as const,
    active: true as const,
  };
  const authority: ProcessingAuthority = {
    async owner(candidate, id) {
      if (!permitted || candidate.actorId !== actor.actorId || id !== meetingId)
        throw new AppError("FORBIDDEN", 403);
    },
    async create() {
      await beforeGrant();
      grantCreated = true;
      return grant;
    },
    async grant() {
      if (!permitted) throw new AppError("FORBIDDEN", 403);
      return grant;
    },
    async workspace() {
      if (!permitted) throw new AppError("FORBIDDEN", 403);
      return { meetingId, ownerId: actor.actorId, meetingVersion: 1 };
    },
    async withdraw(_actor, intent) {
      if (withdrawUnavailable) throw new AppError("PROCESSING_WITHDRAWAL_UNKNOWN", 503);
      return {
        captureId: intent.captureId,
        meetingId: intent.meetingId,
        consentId: grantCreated ? consentId : null,
        version: grantCreated ? 2 : null,
        active: false,
        creationBlocked: true,
      };
    },
    async cleanup() {},
  };
  const service = new CaptureProcessingService(repository, authority),
    proof = {
      consentId,
      expectedVersion: 1,
      meetingId,
      captureId: capture.id,
      policyVersion: "english-text-v1",
    };
  const background = { ...actor, operationGrantId: consentId, sessionId: `operation:${consentId}` };
  return {
    actor,
    capture,
    meetingId,
    service,
    proof,
    background,
    set permitted(value: boolean) {
      permitted = value;
    },
    set beforeGrant(value: () => Promise<void>) {
      beforeGrant = value;
    },
    set withdrawUnavailable(value: boolean) {
      withdrawUnavailable = value;
    },
  };
}
async function finalize(f: Awaited<ReturnType<typeof fixture>>) {
  const segment = {
    id: randomUUID(),
    revision: 1,
    startMs: 0,
    endMs: 1000,
    text: "English meeting evidence",
    speakerLabel: null,
    finalized: true,
  };
  await captures.scoped(f.actor.workspaceId, async (tx) => {
    await tx.storeSegment(f.capture.id, segment);
    await tx.update(f.capture.id, { state: "complete", coverage: "no_detected_gaps" });
  });
  return segment;
}
test("transcript revision tracks only evidence/finalization and is stable through quota and lease bookkeeping", async () => {
  const f = await fixture(),
    segment = await finalize(f),
    before = (await repository.capture(f.actor.workspaceId, f.capture.id))!;
  assert(before.transcriptRevision > 0);
  await captures.scoped(f.actor.workspaceId, (tx) =>
    tx.update(f.capture.id, {
      quotaState: "settled",
      leaseUntil: new Date(),
      leaseToken: randomUUID(),
    }),
  );
  assert.equal(
    (await repository.capture(f.actor.workspaceId, f.capture.id))!.transcriptRevision,
    before.transcriptRevision,
  );
  await captures.scoped(f.actor.workspaceId, (tx) =>
    tx.storeSegment(f.capture.id, { ...segment, revision: 2, text: "Human-corrected evidence" }),
  );
  assert.equal(
    (await repository.capture(f.actor.workspaceId, f.capture.id))!.transcriptRevision,
    before.transcriptRevision + 1,
  );
});
test("restricted processing evidence requires exact live consent/ownership/final generation and forced tenant RLS", async () => {
  const f = await fixture();
  await f.service.consent(f.actor, f.capture.id, randomUUID(), {
    consent: true,
    policyVersion: "english-text-v1",
  });
  await assert.rejects(
    f.service.evidence(f.background, f.capture.id, {
      proof: f.proof,
      transcriptRevision: 1,
      cursor: null,
    }),
    /PROCESSING_NOT_FINAL/,
  );
  await finalize(f);
  const capture = (await repository.capture(f.actor.workspaceId, f.capture.id))!,
    input = { proof: f.proof, transcriptRevision: capture.transcriptRevision, cursor: null };
  const evidence = await f.service.evidence(f.background, f.capture.id, input);
  assert.equal(evidence.segments[0]!.text, "English meeting evidence");
  assert.equal(evidence.meetingId, f.meetingId);
  assert.equal(evidence.transcriptRevision, capture.transcriptRevision);
  await assert.rejects(
    f.service.evidence(f.background, randomUUID(), input),
    /PROCESSING_SCOPE_MISMATCH/,
  );
  await assert.rejects(f.service.evidence(f.actor, f.capture.id, input), /FORBIDDEN/);
  await assert.rejects(
    f.service.evidence(f.background, f.capture.id, {
      ...input,
      transcriptRevision: capture.transcriptRevision + 1,
    }),
    /PROCESSING_REVISION_CHANGED/,
  );
  assert.equal((await pool.query("SELECT * FROM capture_processing_intents")).rows.length, 0);
  f.permitted = false;
  await assert.rejects(f.service.evidence(f.background, f.capture.id, input), /FORBIDDEN/);
});
test("pending withdrawal fences a late grant ACK and cannot reactivate evidence or repeat opt-in", async () => {
  const f = await fixture();
  f.withdrawUnavailable = true;
  f.beforeGrant = async () => {
    const pending = (await repository.intent(f.actor.workspaceId, f.capture.id))!;
    assert.equal(pending.consentId, null);
    const withdrawn = await f.service.withdraw(f.actor, f.capture.id, randomUUID(), {
      expectedIntentVersion: pending.intentVersion,
    });
    assert.equal(withdrawn.state, "withdraw_requested");
    assert.equal(withdrawn.intentVersion, 2);
  };
  const result = await f.service.consent(f.actor, f.capture.id, randomUUID(), {
    consent: true,
    policyVersion: "english-text-v1",
  });
  assert.equal(result.state, "withdraw_requested");
  assert.equal(result.consentId, f.proof.consentId);
  await finalize(f);
  await assert.rejects(
    f.service.evidence(f.background, f.capture.id, {
      proof: f.proof,
      transcriptRevision: (await repository.capture(f.actor.workspaceId, f.capture.id))!
        .transcriptRevision,
      cursor: null,
    }),
    /PROCESSING_SCOPE_MISMATCH/,
  );
  await assert.rejects(f.service.ownerContext(f.actor, f.capture.id), /PROCESSING_NOT_OPTED_IN/);
  assert.equal(
    (
      await f.service.consent(f.actor, f.capture.id, randomUUID(), {
        consent: true,
        policyVersion: "english-text-v1",
      })
    ).state,
    "withdraw_requested",
  );
});
async function nativeFixture() {
  const actor: Actor = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      sessionId: "normal-owner",
    },
    meetingId = randomUUID(),
    consentId = randomUUID();
  let unavailable = true,
    reservations = 0,
    creates = 0,
    cleanupFails = false,
    cleanupCalls = 0;
  const authority: ProcessingAuthority = {
    async owner(candidate, target) {
      if (candidate.actorId !== actor.actorId || target !== meetingId)
        throw new AppError("FORBIDDEN", 403);
    },
    async create(candidate, captureId) {
      const context = await processing.ownerContext(candidate, captureId);
      assert.equal(context.optedIn, true);
      if (unavailable) throw new AppError("PROCESSING_AUTHORITY_UNAVAILABLE", 503);
      return {
        consentId,
        workspaceId: actor.workspaceId,
        ownerId: actor.actorId,
        meetingId,
        captureId,
        version: 1,
        policyVersion: "english-text-v1",
        active: true,
      };
    },
    async grant() {
      throw new AppError("NOT_CONFIGURED_TEST", 503);
    },
    async workspace() {
      throw new AppError("NOT_CONFIGURED_TEST", 503);
    },
    async withdraw(_actor, intent) {
      return {
        captureId: intent.captureId,
        meetingId,
        consentId: intent.consentId,
        version: intent.consentId ? 2 : null,
        active: false,
        creationBlocked: true,
      };
    },
    async cleanup() {
      cleanupCalls++;
      if (cleanupFails) throw new AppError("PROCESSING_AUTHORITY_UNAVAILABLE", 503);
    },
  };
  const processing = new CaptureProcessingService(repository, authority),
    held = new Set<string>();
  const capture = new CaptureService(
    captures,
    {
      async capture() {
        return {
          meetingId,
          ownerId: actor.actorId,
          joinUrl: "https://meet.google.com/abc-defg-hij",
          version: 1,
        };
      },
      async read() {},
      async manage() {},
    },
    {
      async lookup(_actor, id) {
        return held.has(id) ? { state: "held", maxSeconds: 120 } : null;
      },
      async reserve(_actor, id) {
        reservations++;
        held.add(id);
        return "held";
      },
      async release(_actor, id) {
        held.delete(id);
      },
      async settle() {},
    },
    {
      async create() {
        creates++;
        return { kind: "accepted", providerId: randomUUID() };
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
    undefined,
    processing,
  );
  const app = ingestApp(
    capture,
    async (token) => (token === "reader" ? { ...actor, actorId: randomUUID() } : actor),
    new RecallSignatures(["whsec_" + Buffer.alloc(32, 1).toString("base64")]),
    undefined,
    undefined,
    async () => actor,
    {
      service: processing,
      authenticateOwner: async (token) => {
        if (token !== "account") throw new AppError("FORBIDDEN", 403);
        return actor;
      },
      authenticateEvidence: async (token) => {
        if (token !== "intelligence") throw new AppError("FORBIDDEN", 403);
        return { ...actor, operationGrantId: consentId, sessionId: `operation:${consentId}` };
      },
    },
  );
  return {
    actor,
    meetingId,
    capture,
    processing,
    app,
    get reservations() {
      return reservations;
    },
    get creates() {
      return creates;
    },
    get cleanupCalls() {
      return cleanupCalls;
    },
    set unavailable(value: boolean) {
      unavailable = value;
    },
    set cleanupFails(value: boolean) {
      cleanupFails = value;
    },
  };
}
test("inline opt-in commits intent before grant, blocks quota/dispatch on failure and withdrawal permits capture-only", async () => {
  const f = await nativeFixture();
  try {
    const input = {
      meetingId: f.meetingId,
      expectedMeetingVersion: 1,
      maxDurationSeconds: 120,
      processing: { consent: true, policyVersion: "english-text-v1" },
    };
    const key = randomUUID(),
      request = await f.capture.request(f.actor, key, input),
      status = await f.processing.status(f.actor, request.id);
    assert.equal(status!.state, "configuration_error");
    assert.equal(request.ready, false);
    assert.equal(f.reservations, 0);
    await f.capture.work(f.actor.workspaceId, request.id);
    assert.equal(f.reservations, 0);
    assert.equal(f.creates, 0);
    const withdrawn = await f.processing.withdraw(f.actor, request.id, randomUUID(), {
      expectedIntentVersion: status!.intentVersion,
    });
    assert.equal(withdrawn.state, "revoked");
    await f.capture.work(f.actor.workspaceId, request.id);
    assert.equal(f.reservations, 1);
    assert.equal(f.creates, 1);
    assert.equal((await f.capture.status(f.actor, request.id)).stopRequested, false);
    await assert.rejects(
      f.capture.request({ ...f.actor, operationGrantId: randomUUID() }, randomUUID(), input),
      /FORBIDDEN/,
    );
  } finally {
    await f.app.close();
  }
});
test("native status is owner-only for processing, mutation requires keys and deletion awaits Account cleanup", async () => {
  const f = await nativeFixture();
  f.unavailable = false;
  try {
    const root = `/api/v3/workspaces/${f.actor.workspaceId}`,
      created = await f.app.inject({
        method: "POST",
        url: `${root}/captures`,
        headers: { authorization: "Bearer owner", "idempotency-key": randomUUID() },
        payload: {
          meetingId: f.meetingId,
          expectedMeetingVersion: 1,
          maxDurationSeconds: 120,
          processing: { consent: true, policyVersion: "english-text-v1" },
        },
      });
    assert.equal(created.statusCode, 202);
    const id = created.json().id;
    const loaded = await f.app.inject({
      method: "GET",
      url: `${root}/captures/${id}`,
      headers: { authorization: "Bearer owner" },
    });
    assert.equal(loaded.json().processing.state, "ready");
    assert.equal(loaded.json().processing.intentVersion, 1);
    const reader = await f.app.inject({
      method: "GET",
      url: `${root}/captures/${id}`,
      headers: { authorization: "Bearer reader" },
    });
    assert.equal(reader.json().processing, null);
    const missingKey = await f.app.inject({
      method: "POST",
      url: `${root}/captures/${id}/processing-consent/withdraw`,
      headers: { authorization: "Bearer owner" },
      payload: { expectedIntentVersion: 1 },
    });
    assert.equal(missingKey.statusCode, 400);
    const ownerContext = await f.app.inject({
      method: "POST",
      url: `/internal/workspaces/${f.actor.workspaceId}/captures/${id}/processing-owner-context`,
      headers: { authorization: "Bearer account" },
      payload: {},
    });
    assert.equal(ownerContext.statusCode, 200);
    f.cleanupFails = true;
    const deletionId = randomUUID();
    await assert.rejects(
      f.capture.deleteMeeting(f.actor.workspaceId, deletionId, {
        meetingId: f.meetingId,
        sourceVersion: 1,
      }),
      /PROCESSING_AUTHORITY_UNAVAILABLE/,
    );
    assert.equal(f.cleanupCalls, 1);
    f.cleanupFails = false;
    await f.capture.deleteMeeting(f.actor.workspaceId, deletionId, {
      meetingId: f.meetingId,
      sourceVersion: 1,
    });
    assert.equal(f.cleanupCalls, 2);
    assert.equal((await repository.intent(f.actor.workspaceId, id))!.state, "revoked");
  } finally {
    await f.app.close();
  }
});
test("processing evidence enforces total UTF8 byte budget instead of silently truncating text", async () => {
  const f = await fixture();
  await f.service.consent(f.actor, f.capture.id, randomUUID(), {
    consent: true,
    policyVersion: "english-text-v1",
  });
  await captures.scoped(f.actor.workspaceId, async (tx) => {
    for (let index = 0; index < 17; index++)
      await tx.storeSegment(f.capture.id, {
        id: randomUUID(),
        revision: 1,
        startMs: index * 1000,
        endMs: index * 1000 + 1000,
        text: "😀".repeat(32000),
        speakerLabel: null,
        finalized: true,
      });
    await tx.update(f.capture.id, { state: "complete", coverage: "no_detected_gaps" });
  });
  const revision = (await repository.capture(f.actor.workspaceId, f.capture.id))!
    .transcriptRevision;
  await assert.rejects(
    f.service.evidence(f.background, f.capture.id, {
      proof: f.proof,
      transcriptRevision: revision,
      cursor: null,
    }),
    /PROCESSING_EVIDENCE_TOO_LARGE/,
  );
});
