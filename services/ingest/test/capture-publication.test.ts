import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { AppError, ServiceIdentity, serviceToken } from "@visualsprint/platform";
import {
  CaptureProcessingPublisher,
  type CapturePublication,
  type CapturePublicationRepository,
} from "../src/application/capture-processing-publication.js";
import {
  CaptureProcessingService,
  type ProcessingRepository,
  type ProcessingAuthority,
  type ProcessingIntent,
} from "../src/application/capture-processing.js";
import { processingPublisherConfig } from "../src/infrastructure/capture-processing-publisher-runtime.js";
import { ingestApp } from "../src/http/app.js";
import { RecallSignatures } from "../src/infrastructure/webhook-signature.js";
import type { CaptureService } from "../src/application/capture-service.js";

function fixture() {
  const candidate: CapturePublication = {
    workspaceId: randomUUID(),
    captureId: randomUUID(),
    meetingId: randomUUID(),
    ownerId: randomUUID(),
    consentId: randomUUID(),
    consentVersion: 1,
    transcriptRevision: 9,
    policyVersion: "english-text-v1",
  };
  let deferred = 0,
    denied: AppError | null = null,
    changed = false;
  const publications = new Map<string, Parameters<CapturePublicationRepository["commit"]>[1]>();
  const repository: CapturePublicationRepository = {
    async due() {
      return [{ workspaceId: candidate.workspaceId, captureId: candidate.captureId }];
    },
    async candidate() {
      return { ...candidate };
    },
    async defer() {
      deferred++;
    },
    async commit(value, decision) {
      if (changed) throw new AppError("PROCESSING_CONTEXT_CHANGED", 409);
      const key = `${value.captureId}:${value.transcriptRevision}:${value.consentId}:${value.consentVersion}`;
      if (!publications.has(key)) publications.set(key, decision);
    },
  };
  const service = new CaptureProcessingPublisher(repository, {
    async readyContext(actor, captureId, body) {
      assert.equal(actor.operationGrantId, candidate.consentId);
      assert.equal(actor.sessionId, `operation:${candidate.consentId}`);
      assert.equal(captureId, candidate.captureId);
      assert.equal(
        (body as { transcriptRevision: number }).transcriptRevision,
        candidate.transcriptRevision,
      );
      if (denied) throw denied;
      return { ...candidate, state: "complete" as const, ready: true as const };
    },
  });
  return {
    candidate,
    publications,
    service,
    get deferred() {
      return deferred;
    },
    set denied(value: AppError | null) {
      denied = value;
    },
    set changed(value: boolean) {
      changed = value;
    },
  };
}
test("publication emits metadata-only exact generation/consent references and duplicate work preserves one outbox identity", async () => {
  const f = fixture();
  await f.service.work(f.candidate.workspaceId, f.candidate.captureId);
  await f.service.work(f.candidate.workspaceId, f.candidate.captureId);
  assert.equal(f.publications.size, 1);
  const decision = [...f.publications.values()][0]!;
  assert.ok("event" in decision);
  assert.equal(decision.event.type, "capture.processing.ready.v1");
  assert.equal(decision.event.aggregateVersion, 9);
  assert.equal(decision.event.actorId, f.candidate.ownerId);
  assert.deepEqual(
    decision.event.references.map((ref) => ref.kind),
    ["meeting", "capture", "processing_consent"],
  );
  assert.equal("payload" in decision.event, false);
  f.candidate.transcriptRevision++;
  await f.service.work(f.candidate.workspaceId, f.candidate.captureId);
  assert.equal(f.publications.size, 2);
});
test("hard revocation produces durable rejection while uncertain authority and changed source never publish", async () => {
  const revoked = fixture();
  revoked.denied = new AppError("FORBIDDEN", 403);
  await revoked.service.work(revoked.candidate.workspaceId, revoked.candidate.captureId);
  assert.deepEqual([...revoked.publications.values()], [{ rejectionCode: "FORBIDDEN" }]);
  const unknown = fixture();
  unknown.denied = new AppError("AUTHORITY_UNAVAILABLE", 503);
  await unknown.service.work(unknown.candidate.workspaceId, unknown.candidate.captureId);
  assert.equal(unknown.publications.size, 0);
  assert.equal(unknown.deferred, 1);
  const changed = fixture();
  changed.changed = true;
  await assert.rejects(
    changed.service.work(changed.candidate.workspaceId, changed.candidate.captureId),
    /PROCESSING_CONTEXT_CHANGED/,
  );
  assert.equal(changed.publications.size, 0);
});
function readyFixture() {
  const f = fixture(),
    candidate = f.candidate;
  let generation = candidate.transcriptRevision,
    state: ProcessingIntent["state"] = "ready",
    revoked = false,
    reads = 0,
    changeDuringRead = false;
  const actor = {
    workspaceId: candidate.workspaceId,
    actorId: candidate.ownerId,
    operationGrantId: candidate.consentId,
    sessionId: `operation:${candidate.consentId}`,
  };
  const proof = {
    consentId: candidate.consentId,
    expectedVersion: 1,
    captureId: candidate.captureId,
    meetingId: candidate.meetingId,
    policyVersion: "english-text-v1",
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("unused test port");
  };
  const repository: ProcessingRepository = {
    create: unexpected,
    bind: unexpected,
    withdraw: unexpected,
    page: unexpected,
    finishWithdrawal: unexpected,
    error: unexpected,
    hasMeetingIntents: unexpected,
    deleteMeeting: unexpected,
    async capture() {
      reads++;
      return {
        captureId: candidate.captureId,
        meetingId: candidate.meetingId,
        ownerId: candidate.ownerId,
        state: "complete",
        transcriptRevision: changeDuringRead && reads > 1 ? generation + 1 : generation,
        coverage: "known_gaps",
        deleted: false,
      };
    },
    async intent() {
      return {
        workspaceId: candidate.workspaceId,
        captureId: candidate.captureId,
        meetingId: candidate.meetingId,
        ownerId: candidate.ownerId,
        intentVersion: 1,
        state,
        consentId: candidate.consentId,
        consentVersion: 1,
        policyVersion: "english-text-v1",
        errorCode: null,
      };
    },
  };
  const authority: ProcessingAuthority = {
    owner: unexpected,
    create: unexpected,
    withdraw: unexpected,
    cleanup: unexpected,
    async grant() {
      if (revoked) throw new AppError("FORBIDDEN", 403);
      return {
        workspaceId: candidate.workspaceId,
        captureId: candidate.captureId,
        meetingId: candidate.meetingId,
        ownerId: candidate.ownerId,
        consentId: candidate.consentId,
        version: 1,
        policyVersion: "english-text-v1",
        active: true,
      };
    },
    async workspace() {
      return { meetingId: candidate.meetingId, ownerId: candidate.ownerId, meetingVersion: 3 };
    },
  };
  return {
    candidate,
    actor,
    proof,
    service: new CaptureProcessingService(repository, authority),
    set state(value: ProcessingIntent["state"]) {
      state = value;
    },
    set revoked(value: boolean) {
      revoked = value;
    },
    set changeDuringRead(value: boolean) {
      changeDuringRead = value;
    },
    set generation(value: number) {
      generation = value;
    },
  };
}
test("ready metadata requires current exact operation grant, final revision and an unwithdrawn intent", async () => {
  const f = readyFixture();
  const body = { proof: f.proof, transcriptRevision: 9 };
  const result = await f.service.readyContext(f.actor, f.candidate.captureId, body);
  assert.equal(result.ready, true);
  assert.equal(result.transcriptRevision, 9);
  assert.equal("segments" in result, false);
  await assert.rejects(
    f.service.readyContext(
      { ...f.actor, operationGrantId: randomUUID() },
      f.candidate.captureId,
      body,
    ),
    /FORBIDDEN/,
  );
  f.state = "withdraw_requested";
  await assert.rejects(
    f.service.readyContext(f.actor, f.candidate.captureId, body),
    /PROCESSING_SCOPE_MISMATCH/,
  );
  const corrected = readyFixture();
  corrected.changeDuringRead = true;
  await assert.rejects(
    corrected.service.readyContext(corrected.actor, corrected.candidate.captureId, {
      proof: corrected.proof,
      transcriptRevision: 9,
    }),
    /PROCESSING_REVISION_CHANGED/,
  );
});
test("native readiness transport pins Account and does not reuse normal-user owner-context authority", async () => {
  const f = readyFixture(),
    keys = await generateKeyPair("EdDSA"),
    publicKey = { ...(await exportJWK(keys.publicKey)), kid: "ready-fixture" };
  const identity = new ServiceIdentity("ingest", { account: [publicKey] });
  const app = ingestApp(
    {} as CaptureService,
    async () => f.actor,
    new RecallSignatures([`whsec_${Buffer.alloc(32, 1).toString("base64")}`]),
    undefined,
    undefined,
    undefined,
    {
      service: f.service,
      authenticateOwner: async (token) => (await identity.verify(token)).actor,
      async authenticateEvidence() {
        throw new Error("not evidence");
      },
    },
  );
  const auth = async (caller: "account" | "intelligence") =>
    `Bearer ${await serviceToken({ caller, audience: "ingest", actor: f.actor, privateKey: keys.privateKey, keyId: "ready-fixture" })}`;
  const path = `/internal/workspaces/${f.candidate.workspaceId}/captures/${f.candidate.captureId}/processing-ready-context`;
  try {
    const accepted = await app.inject({
      method: "POST",
      url: path,
      headers: { authorization: await auth("account") },
      payload: { proof: f.proof, transcriptRevision: 9 },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().ready, true);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: await auth("intelligence") },
          payload: { proof: f.proof, transcriptRevision: 9 },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
test("processing publisher runtime cannot start without both explicit affirmative flags", () => {
  const base = {
    INGEST_DATABASE_URL: "local",
    WORKSPACE_INTERNAL_URL: "http://127.0.0.1:4102",
    ACCOUNT_INTERNAL_URL: "http://127.0.0.1:4101",
    SERVICE_PRIVATE_JWK: "configured-at-runtime",
    SERVICE_KEY_ID: "ingest",
  };
  assert.throws(() => processingPublisherConfig.parse(base));
  assert.throws(() =>
    processingPublisherConfig.parse({
      ...base,
      CAPTURE_PROCESSING_ENABLED: "true",
      CAPTURE_EXTRACTION_PUBLISH_ENABLED: "false",
    }),
  );
  assert.ok(
    processingPublisherConfig.parse({
      ...base,
      CAPTURE_PROCESSING_ENABLED: "true",
      CAPTURE_EXTRACTION_PUBLISH_ENABLED: "true",
    }),
  );
});
