import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { ServiceIdentity } from "@visualsprint/platform";
import {
  CaptureProcessingClient,
  AuthorizedCaptureExtractionEvidence,
  CaptureModelAdmission,
} from "../src/infrastructure/capture-processing-client.js";
import type { FinalizedCaptureProof } from "../src/application/capture-extraction.js";

async function fixture() {
  const proof: FinalizedCaptureProof = {
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    meetingId: randomUUID(),
    captureId: randomUUID(),
    consentId: randomUUID(),
    consentVersion: 2,
    transcriptRevision: 9,
    policyVersion: "english-text-v1",
  };
  const keys = await generateKeyPair("EdDSA"),
    publicKey = { ...(await exportJWK(keys.publicKey)), kid: "capture-client" };
  const requests: { path: string; body: Record<string, unknown> | undefined }[] = [];
  const segments = [
    {
      id: randomUUID(),
      revision: 2,
      startMs: 0,
      endMs: 100,
      text: "first",
      speakerLabel: null,
      finalized: true,
    },
    {
      id: randomUUID(),
      revision: 3,
      startMs: 100,
      endMs: 200,
      text: "second",
      speakerLabel: "Founder",
      finalized: true,
    },
  ];
  let malformed = false,
    replay = false,
    reserveStatus = 200;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      audience = url.port === "4101" ? "account" : url.port === "4102" ? "workspace" : "ingest";
    assert.equal(init?.redirect, "error");
    const token = new Headers(init?.headers).get("authorization")!.slice(7);
    const hop = await new ServiceIdentity(audience, { intelligence: [publicKey] }).verify(token);
    assert.equal(hop.actor.workspaceId, proof.workspaceId);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    requests.push({ path: url.pathname, body });
    if (url.pathname === `/api/v3/workspaces/${proof.workspaceId}/meetings/${proof.meetingId}`) {
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(hop.actor.operationGrantId, undefined);
      return Response.json({
        id: proof.meetingId,
        ownerId: proof.ownerId,
        title: "Only owner metadata is parsed",
        notes: "Owner authorized text",
      });
    }
    assert.equal(init?.method, "POST");
    assert.equal(hop.actor.operationGrantId, proof.consentId);
    assert.equal(hop.actor.sessionId, `operation:${proof.consentId}`);
    if (url.pathname.endsWith("/authorize"))
      return Response.json({
        consentId: proof.consentId,
        workspaceId: proof.workspaceId,
        ownerId: proof.ownerId,
        meetingId: proof.meetingId,
        captureId: proof.captureId,
        version: proof.consentVersion,
        policyVersion: proof.policyVersion,
        active: true,
      });
    if (url.pathname.endsWith("/capture-processing-context"))
      return Response.json({
        meetingId: proof.meetingId,
        ownerId: proof.ownerId,
        meetingVersion: 4,
      });
    if (url.pathname.endsWith("/processing-evidence")) {
      assert.equal(body!.transcriptRevision, 9);
      const cursor = body!.cursor;
      return Response.json({
        workspaceId: proof.workspaceId,
        captureId: proof.captureId,
        meetingId: proof.meetingId,
        ownerId: proof.ownerId,
        meetingVersion: 4,
        transcriptRevision: 9,
        coverage: "known_gaps",
        segments: [malformed && cursor ? segments[0] : segments[cursor ? 1 : 0]],
        totalSegments: 2,
        totalBytes: 11,
        nextCursor: cursor ? null : "page_two",
      });
    }
    if (url.pathname.endsWith("/reservations"))
      if (reserveStatus !== 200) return new Response(null, { status: reserveStatus });
    if (url.pathname.endsWith("/reservations"))
      return Response.json({ reservationId, state: "held", replay });
    if (url.pathname.endsWith("/record"))
      return Response.json({ reservationId, state: body!.outcome });
    throw new Error("unexpected capture request");
  };
  const reservationId = randomUUID();
  const client = new CaptureProcessingClient(
    {
      account: "http://127.0.0.1:4101",
      workspace: "http://127.0.0.1:4102",
      ingest: "http://127.0.0.1:4104",
    },
    keys.privateKey,
    "capture-client",
    transport,
  );
  return {
    proof,
    client,
    requests,
    reservationId,
    set malformed(value: boolean) {
      malformed = value;
    },
    set replay(value: boolean) {
      replay = value;
    },
    set reserveStatus(value: number) {
      reserveStatus = value;
    },
  };
}
test("dedicated capture client signs exact narrow proofs, drains bounded pages and never uses generic context", async () => {
  const f = await fixture(),
    evidence = new AuthorizedCaptureExtractionEvidence(f.client);
  const snapshot = await evidence.read(f.proof);
  assert.equal(snapshot.evidence.length, 2);
  assert.equal(snapshot.evidence[1]!.revision, 3);
  assert.equal(snapshot.versions[0]!.captureVersion, 9);
  assert.equal(snapshot.versions[0]!.coverage, "partial");
  assert.equal(
    f.requests.some((row) => row.path.endsWith("/intelligence-context")),
    false,
  );
  await evidence.owner(
    { actorId: f.proof.ownerId, workspaceId: f.proof.workspaceId, sessionId: "current-user" },
    f.proof.meetingId,
  );
  await assert.rejects(
    evidence.owner(
      { actorId: randomUUID(), workspaceId: f.proof.workspaceId, sessionId: "other-member" },
      f.proof.meetingId,
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(
    evidence.owner(
      {
        actorId: f.proof.ownerId,
        workspaceId: f.proof.workspaceId,
        sessionId: `operation:${f.proof.consentId}`,
        operationGrantId: f.proof.consentId,
      },
      f.proof.meetingId,
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(
    f.client.request(
      { actorId: f.proof.ownerId, workspaceId: f.proof.workspaceId, sessionId: "owner" },
      "workspace",
      `/api/v3/workspaces/${f.proof.workspaceId}/projects`,
    ),
    /PROCESSING_SCOPE_MISMATCH/,
  );
  f.malformed = true;
  await assert.rejects(evidence.read(f.proof), /INVALID_PROCESSING_EVIDENCE/);
});

test("explicit capture budget exhaustion remains actionable and never records a provider dispatch intent", async () => {
  const f = await fixture();
  f.reserveStatus = 402;
  const admission = new CaptureModelAdmission(f.client, {
    async intent() {
      throw new Error("no dispatch allowed");
    },
    async record() {},
  });
  await assert.rejects(
    admission.reserve(f.proof, {
      operationId: randomUUID(),
      maxInputTokens: 100,
      maxOutputTokens: 6000,
    }),
    (error) =>
      error instanceof Error &&
      error.message === "MODEL_BUDGET_EXHAUSTED" &&
      "status" in error &&
      error.status === 402,
  );
});
test("capture admission uses purpose-isolated grant body and persists one-shot intent only on first held reserve", async () => {
  const f = await fixture(),
    intents: string[] = [],
    records: string[] = [];
  const admission = new CaptureModelAdmission(f.client, {
    async intent(actor, operation, reservation) {
      assert.equal(actor.operationGrantId, f.proof.consentId);
      assert.equal(reservation, f.reservationId);
      intents.push(operation);
    },
    async record(_actor, _reservation, outcome) {
      records.push(outcome);
    },
  });
  const input = { operationId: randomUUID(), maxInputTokens: 1000, maxOutputTokens: 6000 };
  await admission.reserve(f.proof, input);
  f.replay = true;
  await admission.reserve(f.proof, input);
  assert.equal(intents.length, 1);
  const reserve = f.requests.find((row) => row.path.endsWith("/reservations"))!;
  assert.equal(reserve.body!.purpose, "capture_extraction");
  assert.equal(reserve.body!.transcriptRevision, 9);
  assert.equal((reserve.body!.proof as { expectedVersion: number }).expectedVersion, 2);
  await admission.record(f.proof, input.operationId, f.reservationId, "unknown");
  assert.deepEqual(records, ["unknown"]);
  const cleanup = f.requests.at(-1)!;
  assert.deepEqual(cleanup.body, { operationId: input.operationId, outcome: "unknown" });
});
