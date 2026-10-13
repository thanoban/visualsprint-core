import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { AppError, ServiceIdentity } from "@visualsprint/platform";
import { AuthorizedCommitmentEvidence } from "../src/infrastructure/commitment-source.js";
import { acceptanceInput, reviewedContent } from "../src/application/commitments.js";
test("accepted review requires explicit confirmation, exact citations and valid optional dates", () => {
  const ref = { captureId: randomUUID(), segmentId: randomUUID(), revision: 1 },
    content = {
      title: "Human review",
      text: "Reviewed statement",
      ownerId: null,
      dueDate: null,
      citations: [ref],
    };
  assert.equal(
    acceptanceInput.safeParse({
      meetingId: randomUUID(),
      expectedMeetingVersion: 1,
      confirmed: false,
      content,
    }).success,
    false,
  );
  assert.equal(reviewedContent.safeParse({ ...content, citations: [ref, ref] }).success, false);
  assert.equal(
    reviewedContent.safeParse({
      ...content,
      citations: [{ ...ref, text: "untrusted evidence text" }],
    }).success,
    false,
  );
  assert.equal(reviewedContent.safeParse({ ...content, dueDate: "2026-02-30" }).success, false);
  assert.equal(reviewedContent.safeParse({ ...content, dueDate: "2028-02-29" }).success, true);
});
test("signed authoritative evidence lookup ignores client text and preserves partial/revision checks", async () => {
  const keys = await generateKeyPair("EdDSA"),
    kid = "workspace-review",
    publicKey = { ...(await exportJWK(keys.publicKey)), kid },
    actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "fixture" },
    meetingId = randomUUID(),
    ref = { captureId: randomUUID(), segmentId: randomUUID(), revision: 2 };
  const row = {
    ...ref,
    captureVersion: 3,
    state: "partial",
    coverage: "known_gaps",
    text: "Exact original evidence",
    finalized: true,
    startMs: 0,
    endMs: 1000,
    speakerLabel: null,
  };
  const source = new AuthorizedCommitmentEvidence(
    "https://ingest.example",
    undefined,
    keys.privateKey,
    kid,
    async (url, init) => {
      assert.equal(
        String(url),
        `https://ingest.example/internal/workspaces/${actor.workspaceId}/evidence-batch`,
      );
      const authorization = (init?.headers as Record<string, string>).authorization!;
      assert.deepEqual(
        (
          await new ServiceIdentity("ingest", { workspace: [publicKey] }).verify(
            authorization.slice(7),
          )
        ).actor,
        actor,
      );
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), { meetingId, citations: [ref] });
      return Response.json({ meetingId, segments: [row] });
    },
  );
  const proof = await source.validate(actor, meetingId, [ref]);
  assert.equal(proof.partial, true);
  assert.equal(proof.citations[0]?.coverage, "partial");
  assert.equal(JSON.stringify(proof).includes(row.text), false);
  const changed = new AuthorizedCommitmentEvidence(
    "https://ingest.example",
    undefined,
    keys.privateKey,
    kid,
    async () => Response.json({ meetingId, segments: [{ ...row, revision: 3 }] }),
  );
  await assert.rejects(
    changed.validate(actor, meetingId, [ref]),
    (e) => e instanceof AppError && e.code === "SOURCE_EVIDENCE_CHANGED",
  );
  await assert.rejects(
    source.proposal(actor, randomUUID(), 0),
    (e) => e instanceof AppError && e.code === "PROPOSAL_REVIEW_NOT_CONFIGURED",
  );
});
test("proposal reference is retrieved from current signed Intelligence result, not client copied content", async () => {
  const keys = await generateKeyPair("EdDSA"),
    actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "fixture" },
    jobId = randomUUID(),
    ref = {
      meetingId: randomUUID(),
      captureId: randomUUID(),
      segmentId: randomUUID(),
      revision: 1,
    };
  const source = new AuthorizedCommitmentEvidence(
    "https://ingest.example",
    "https://intelligence.example",
    keys.privateKey,
    "fixture",
    async (url, init) => {
      assert.equal(init?.method, "GET");
      assert.equal(
        String(url),
        `https://intelligence.example/api/v3/workspaces/${actor.workspaceId}/intelligence/jobs/${jobId}`,
      );
      return Response.json({
        id: jobId,
        status: "complete",
        result: {
          claims: [{ kind: "commitment", text: "We will follow up", citation: ref }],
          reviewRequired: true,
        },
      });
    },
  );
  assert.equal((await source.proposal(actor, jobId, 0)).text, "We will follow up");
  await assert.rejects(
    source.proposal(actor, jobId, 1),
    (e) => e instanceof AppError && e.code === "PROPOSAL_NOT_AVAILABLE",
  );
});
