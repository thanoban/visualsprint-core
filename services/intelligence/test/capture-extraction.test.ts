import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppError } from "@visualsprint/platform";
import {
  DurableCaptureExtraction,
  proofFromCaptureEvent,
  type CaptureExtractionJob,
  type CaptureExtractionJobs,
  type CaptureExtractionEvidence,
  type CaptureExtractionAdmission,
  type FinalizedCaptureProof,
} from "../src/application/capture-extraction.js";
import type { Snapshot } from "../src/domain/evidence.js";
import type { Model } from "../src/application/ports.js";

function fixture() {
  const proof: FinalizedCaptureProof = {
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    meetingId: randomUUID(),
    captureId: randomUUID(),
    consentId: randomUUID(),
    consentVersion: 1,
    transcriptRevision: 7,
    policyVersion: "english-text-v1",
  };
  const event = {
    eventId: randomUUID(),
    type: "capture.processing.ready.v1" as const,
    schemaVersion: 1 as const,
    workspaceId: proof.workspaceId,
    aggregateId: proof.captureId,
    aggregateVersion: 7,
    occurredAt: new Date().toISOString(),
    traceId: "a".repeat(32),
    actorId: proof.ownerId,
    references: [
      { kind: "meeting" as const, id: proof.meetingId },
      { kind: "capture" as const, id: proof.captureId, revision: 7 },
      { kind: "processing_consent" as const, id: proof.consentId, revision: 1 },
    ],
  };
  let snapshot: Snapshot = {
    versions: [
      {
        meetingId: proof.meetingId,
        version: 3,
        captureId: proof.captureId,
        captureVersion: 7,
        coverage: "partial",
      },
    ],
    evidence: [
      {
        meetingId: proof.meetingId,
        captureId: proof.captureId,
        segmentId: randomUUID(),
        revision: 2,
        startMs: 0,
        endMs: 1000,
        text: "We will review the launch on Friday.",
        speakerLabel: "Founder",
      },
    ],
  };
  let authorityError: AppError | null = null,
    modelCalls = 0,
    reserves = 0,
    rejections = 0,
    accepts = 0,
    leaseLost = false;
  let evidenceReads = 0;
  let afterEvidenceRead = async (_count: number) => {};
  let beforeModel = async () => {},
    afterReserve = async () => {};
  const job: CaptureExtractionJob = {
    id: randomUUID(),
    proof,
    status: "queued",
    attempts: 0,
    leaseToken: null,
    leaseUntil: null,
    result: null,
    errorCode: null,
    createdAt: new Date(),
  };
  const evidence: CaptureExtractionEvidence = {
    async authorize(candidate) {
      assert.deepEqual(candidate, proof);
      if (authorityError) throw authorityError;
    },
    async read() {
      await afterEvidenceRead(++evidenceReads);
      return structuredClone(snapshot);
    },
    async owner(actor, meeting) {
      if (actor.actorId !== proof.ownerId || meeting !== proof.meetingId)
        throw new AppError("FORBIDDEN", 403);
    },
  };
  const jobs: CaptureExtractionJobs = {
    async accept() {
      accepts++;
      return { id: job.id };
    },
    async reject() {
      rejections++;
    },
    async claim() {
      if (!["queued", "running"].includes(job.status)) return null;
      job.status = "running";
      job.attempts++;
      job.leaseToken = randomUUID();
      job.leaseUntil = new Date(Date.now() + 300000);
      return { ...job };
    },
    async guard() {
      if (leaseLost) throw new AppError("EXTRACTION_LEASE_LOST", 409);
    },
    async complete(_job, result) {
      job.result = result;
      job.status = "complete";
    },
    async fail(_job, code, retry) {
      job.errorCode = code;
      job.status = retry ? "queued" : "failed";
    },
    async due() {
      return [{ workspaceId: proof.workspaceId, id: job.id }];
    },
    async load(actor) {
      return actor.actorId === proof.ownerId ? job : null;
    },
    async list() {
      return [job];
    },
    async invalidate() {
      job.status = "invalidated";
      job.result = null;
    },
    async purgeMeeting() {
      job.status = "invalidated";
      job.result = null;
    },
  };
  const reservations = new Map<
      string,
      { id: string; state: "held" | "succeeded" | "unknown" | "not_started" }
    >(),
    records: string[] = [];
  const admission: CaptureExtractionAdmission = {
    async reserve(candidate, input) {
      assert.deepEqual(candidate, proof);
      reserves++;
      await afterReserve();
      const old = reservations.get(input.operationId);
      if (old) return { reservationId: old.id, replay: true, state: old.state };
      const row = { id: randomUUID(), state: "held" as const };
      reservations.set(input.operationId, row);
      return { reservationId: row.id, replay: false, state: row.state };
    },
    async record(_proof, operationId, reservationId, outcome) {
      const row = reservations.get(operationId)!;
      assert.equal(row.id, reservationId);
      row.state = outcome;
      records.push(outcome);
    },
  };
  let output: unknown = undefined;
  const model: Model = {
    async generate(input) {
      modelCalls++;
      await beforeModel();
      return (
        output ?? {
          claims: [
            {
              kind: "commitment",
              text: input.evidence[0]!.text,
              citation: {
                meetingId: proof.meetingId,
                captureId: proof.captureId,
                segmentId: input.evidence[0]!.segmentId,
                revision: input.evidence[0]!.revision,
              },
            },
          ],
          unsupported: false,
        }
      );
    },
  };
  const service = new DurableCaptureExtraction(jobs, evidence, model, admission, {
    async requireActive(actor) {
      if (actor.actorId !== proof.ownerId) throw new AppError("FORBIDDEN", 403);
    },
    async read() {
      return structuredClone(snapshot);
    },
  });
  return {
    proof,
    event,
    job,
    service,
    jobs,
    records,
    get modelCalls() {
      return modelCalls;
    },
    get reserves() {
      return reserves;
    },
    get rejections() {
      return rejections;
    },
    get accepts() {
      return accepts;
    },
    get snapshot() {
      return snapshot;
    },
    set snapshot(value: Snapshot) {
      snapshot = value;
    },
    set authorityError(value: AppError | null) {
      authorityError = value;
    },
    set beforeModel(value: () => Promise<void>) {
      beforeModel = value;
    },
    set afterReserve(value: () => Promise<void>) {
      afterReserve = value;
    },
    set output(value: unknown) {
      output = value;
    },
    set leaseLost(value: boolean) {
      leaseLost = value;
    },
    set afterEvidenceRead(value: (count: number) => Promise<void>) {
      afterEvidenceRead = value;
    },
  };
}

test("finalized events bind transcript generation rather than operational version and complete evidence-linked partial drafts", async () => {
  const f = fixture();
  assert.deepEqual(proofFromCaptureEvent(f.event).proof, f.proof);
  await f.service.consume(f.event);
  await f.service.work(f.proof.workspaceId, f.job.id);
  assert.equal(f.job.status, "complete");
  assert.equal(f.job.result!.partial, true);
  assert.equal(f.job.result!.reviewRequired, true);
  assert.equal(f.job.result!.claims[0]!.citation.revision, 2);
  assert.equal(f.modelCalls, 1);
  assert.deepEqual(f.records, ["succeeded"]);
});
test("hard revocation is durably rejected before ACK while unknown authority is retried without model work", async () => {
  const f = fixture();
  f.authorityError = new AppError("PROCESSING_FORBIDDEN", 403);
  assert.deepEqual(await f.service.consume(f.event), { id: null, rejected: true });
  assert.equal(f.rejections, 1);
  assert.equal(f.accepts, 0);
  f.authorityError = new AppError("AUTHORITY_UNAVAILABLE", 503);
  await assert.rejects(f.service.consume(f.event), /AUTHORITY_UNAVAILABLE/);
  assert.equal(f.rejections, 1);
  assert.equal(f.reserves, 0);
  assert.equal(f.modelCalls, 0);
});
test("revocation after reservation records not-started and never dispatches the model", async () => {
  const f = fixture();
  f.afterReserve = async () => {
    f.authorityError = new AppError("PROCESSING_FORBIDDEN", 403);
  };
  await f.service.work(f.proof.workspaceId, f.job.id);
  assert.equal(f.job.status, "failed");
  assert.equal(f.modelCalls, 0);
  assert.deepEqual(f.records, ["not_started"]);
});
test("uncertain model completion is held and lease recovery cannot create a second paid operation", async () => {
  const f = fixture();
  f.beforeModel = async () => {
    throw new Error("response lost");
  };
  await f.service.work(f.proof.workspaceId, f.job.id);
  assert.equal(f.job.errorCode, "MODEL_DISPATCH_UNKNOWN");
  assert.deepEqual(f.records, ["unknown"]);
  f.job.status = "queued";
  await f.service.work(f.proof.workspaceId, f.job.id);
  assert.equal(f.job.errorCode, "MODEL_RESERVATION_REPLAY");
  assert.equal(f.modelCalls, 1);
  assert.equal(f.reserves, 2);
});

test("lease expiry during final evidence reread records not-started before any model I/O", async () => {
  const f = fixture();
  f.afterEvidenceRead = async (count) => {
    if (count === 2) f.leaseLost = true;
  };
  await f.service.work(f.proof.workspaceId, f.job.id);
  assert.equal(f.job.errorCode, "EXTRACTION_LEASE_LOST");
  assert.equal(f.modelCalls, 0);
  assert.deepEqual(f.records, ["not_started"]);
});
test("corrected source after model output is not published and invented claims fail exact evidence validation", async () => {
  const f = fixture();
  f.beforeModel = async () => {
    f.snapshot = {
      ...f.snapshot,
      evidence: f.snapshot.evidence.map((row) => ({
        ...row,
        text: "Corrected human evidence",
        revision: 3,
      })),
    };
  };
  await f.service.work(f.proof.workspaceId, f.job.id);
  assert.equal(f.job.errorCode, "SOURCE_CHANGED");
  assert.equal(f.job.result, null);
  const invented = fixture();
  invented.output = {
    claims: [
      {
        kind: "decision",
        text: "The budget is approved",
        citation: {
          meetingId: invented.proof.meetingId,
          captureId: invented.proof.captureId,
          segmentId: invented.snapshot.evidence[0]!.segmentId,
          revision: 2,
        },
      },
    ],
    unsupported: false,
  };
  await invented.service.work(invented.proof.workspaceId, invented.job.id);
  assert.equal(invented.job.errorCode, "EXTRACTION_VALIDATION_FAILED");
  assert.equal(invented.job.result, null);
});
test("missing or foreign evidence never reaches model admission and an empty transcript is explicitly unsupported", async () => {
  const f = fixture();
  f.snapshot = { ...f.snapshot, versions: [{ ...f.snapshot.versions[0]!, captureVersion: 8 }] };
  await f.service.work(f.proof.workspaceId, f.job.id);
  assert.equal(f.reserves, 0);
  assert.equal(f.job.errorCode, "PROCESSING_SCOPE_MISMATCH");
  const empty = fixture();
  empty.snapshot = { ...empty.snapshot, evidence: [] };
  await empty.service.work(empty.proof.workspaceId, empty.job.id);
  assert.equal(empty.reserves, 0);
  assert.equal(empty.job.result!.unsupported, true);
  assert.deepEqual(empty.job.result!.claims, []);
});
test("owner-private draft reads enforce current normal authority and invalidate human-corrected cached content", async () => {
  const f = fixture();
  await f.service.work(f.proof.workspaceId, f.job.id);
  const actor = {
    actorId: f.proof.ownerId,
    workspaceId: f.proof.workspaceId,
    sessionId: "current-owner",
  };
  assert.equal((await f.service.load(actor, f.job.id)).result!.claims.length, 1);
  await assert.rejects(f.service.load({ ...actor, actorId: randomUUID() }, f.job.id), /FORBIDDEN/);
  await assert.rejects(
    f.service.load({ ...actor, operationGrantId: f.proof.consentId }, f.job.id),
    /FORBIDDEN/,
  );
  f.snapshot = {
    ...f.snapshot,
    evidence: f.snapshot.evidence.map((row) => ({ ...row, text: "new text", revision: 3 })),
  };
  await assert.rejects(f.service.load(actor, f.job.id), /SOURCE_CHANGED/);
  assert.equal(f.job.result, null);
  assert.equal(f.job.status, "invalidated");
});
