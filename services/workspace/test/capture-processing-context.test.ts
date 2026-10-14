import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { AppError, ServiceIdentity, type Actor } from "@visualsprint/platform";
import {
  CaptureProcessingContext,
  type ProcessingContextInput,
  processingConsentProof,
} from "../src/application/capture-processing-context.js";
import { AccountCaptureProcessing } from "../src/infrastructure/account-processing-client.js";
function fixture() {
  const input: ProcessingContextInput = {
    consentId: randomUUID(),
    expectedVersion: 2,
    meetingId: randomUUID(),
    captureId: randomUUID(),
    policyVersion: "english-text-v1",
  };
  const actor: Actor = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    operationGrantId: input.consentId,
    sessionId: `operation:${input.consentId}`,
  };
  return {
    input,
    actor,
    proof: {
      consentId: input.consentId,
      workspaceId: actor.workspaceId,
      ownerId: actor.actorId,
      meetingId: input.meetingId,
      captureId: input.captureId,
      version: 2,
      policyVersion: "english-text-v1" as const,
      active: true as const,
    },
  };
}
test("processing context accepts only exact operation grant and current consent target; no metadata authority widening", async () => {
  const f = fixture();
  let checks = 0,
    reads = 0;
  const service = new CaptureProcessingContext(
    {
      async metadata() {
        reads++;
        return { id: f.input.meetingId, ownerId: f.actor.actorId, version: 3, blocked: false };
      },
    },
    {
      async authorize() {
        checks++;
        return f.proof;
      },
    },
  );
  assert.deepEqual(await service.read(f.actor, f.input), {
    meetingId: f.input.meetingId,
    ownerId: f.actor.actorId,
    meetingVersion: 3,
  });
  assert.equal(checks, 2);
  assert.equal(reads, 2);
  await assert.rejects(
    service.read({ ...f.actor, operationGrantId: undefined }, f.input),
    /FORBIDDEN/,
  );
  await assert.rejects(
    service.read({ ...f.actor, sessionId: "normal-session" }, f.input),
    /FORBIDDEN/,
  );
  await assert.rejects(service.read(f.actor, { ...f.input, policyVersion: "all-text-v1" }));
  const wrong = new CaptureProcessingContext(
    {
      async metadata() {
        throw new Error("Must not read unrelated meeting");
      },
    },
    {
      async authorize() {
        return { ...f.proof, captureId: randomUUID() };
      },
    },
  );
  await assert.rejects(wrong.read(f.actor, f.input), /FORBIDDEN/);
});
test("processing grant revoked or meeting deleted/changed during recheck cannot publish metadata", async () => {
  const f = fixture();
  let checks = 0;
  const revoked = new CaptureProcessingContext(
    {
      async metadata() {
        return { id: f.input.meetingId, ownerId: f.actor.actorId, version: 1, blocked: false };
      },
    },
    {
      async authorize() {
        if (++checks === 2) throw new AppError("FORBIDDEN", 403);
        return f.proof;
      },
    },
  );
  await assert.rejects(revoked.read(f.actor, f.input), /FORBIDDEN/);
  let reads = 0;
  const deleted = new CaptureProcessingContext(
    {
      async metadata() {
        return {
          id: f.input.meetingId,
          ownerId: f.actor.actorId,
          version: 1,
          blocked: ++reads === 2,
        };
      },
    },
    {
      async authorize() {
        return f.proof;
      },
    },
  );
  await assert.rejects(deleted.read(f.actor, f.input), /NOT_FOUND/);
  let version = 0;
  const changed = new CaptureProcessingContext(
    {
      async metadata() {
        return {
          id: f.input.meetingId,
          ownerId: f.actor.actorId,
          version: ++version,
          blocked: false,
        };
      },
    },
    {
      async authorize() {
        return f.proof;
      },
    },
  );
  await assert.rejects(changed.read(f.actor, f.input), /PROCESSING_CONTEXT_CHANGED/);
});
test("processing proof client sends signed Workspace operation to pinned Account path and fails closed", async () => {
  const f = fixture(),
    keys = await generateKeyPair("EdDSA"),
    kid = "workspace-processing";
  const verifier = new ServiceIdentity("account", {
    workspace: [{ ...(await exportJWK(keys.publicKey)), kid }],
  });
  let requests = 0;
  const client = new AccountCaptureProcessing(
    "https://account.example",
    keys.privateKey,
    kid,
    async (url, init) => {
      requests++;
      assert.equal(
        String(url),
        `https://account.example/internal/workspaces/${f.actor.workspaceId}/capture-processing/authorize`,
      );
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(init?.body as string), f.input);
      const auth = (init?.headers as Record<string, string>).authorization!;
      assert.deepEqual((await verifier.verify(auth.slice(7))).actor, f.actor);
      return Response.json(f.proof);
    },
  );
  assert.deepEqual(await client.authorize(f.actor, f.input), processingConsentProof.parse(f.proof));
  await assert.rejects(
    client.authorize({ ...f.actor, sessionId: "normal-session" }, f.input),
    /FORBIDDEN/,
  );
  assert.equal(requests, 1);
  assert.throws(
    () =>
      new AccountCaptureProcessing("https://account.example/unsafe?secret=x", keys.privateKey, kid),
    /INVALID_ACCOUNT_PROCESSING_ORIGIN/,
  );
  await assert.rejects(
    new AccountCaptureProcessing("https://account.example", keys.privateKey, kid, async () =>
      Response.json({ error: "do not expose provider text" }, { status: 500 }),
    ).authorize(f.actor, f.input),
    /ACCOUNT_UNAVAILABLE/,
  );
  await assert.rejects(
    new AccountCaptureProcessing("https://account.example", keys.privateKey, kid, async () =>
      Response.json({ active: false }),
    ).authorize(f.actor, f.input),
    /ACCOUNT_UNAVAILABLE/,
  );
});
