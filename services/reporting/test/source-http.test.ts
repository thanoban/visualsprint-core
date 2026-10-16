import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { generateKeyPair, exportJWK } from "jose";
import { AppError, ServiceIdentity, bearer } from "@visualsprint/platform";
import { HttpExportSources } from "../src/infrastructure/source-client.js";
import { reviewedContext } from "./fixtures/evidence.js";
test("real HTTP source adapter delegates Reporting identity to owning services and rechecks revocation before returning text", async () => {
  const keys = await generateKeyPair("EdDSA"),
    kid = "reporting-http",
    jwk = { ...(await exportJWK(keys.publicKey)), kid },
    actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "normal-owner" },
    meetingId = randomUUID(),
    captureId = randomUUID(),
    context = reviewedContext(meetingId),
    workspace = Fastify(),
    ingest = Fastify();
  let allowed = true,
    workspaceReads = 0,
    manifestReads = 0;
  for (const [app, audience] of [
    [workspace, "workspace"],
    [ingest, "ingest"],
  ] as const) {
    const identity = new ServiceIdentity(audience, { reporting: [jwk] });
    app.addHook("preHandler", async (request) => {
      const delegated = await identity.verify(bearer(request.headers.authorization));
      assert.deepEqual(delegated.actor, actor);
      if (!allowed) throw Object.assign(new Error("fixture denied"), { statusCode: 403 });
    });
  }
  workspace.get(`/api/v3/workspaces/${actor.workspaceId}/meetings/${meetingId}`, async () => ({
    id: meetingId,
    version: 1,
    title: "HTTP customer call",
    notes: "Human notes",
  }));
  workspace.get(
    `/internal/workspaces/${actor.workspaceId}/meetings/${meetingId}/export-context`,
    async () => {
      workspaceReads++;
      return context;
    },
  );
  ingest.get(
    `/internal/workspaces/${actor.workspaceId}/meetings/${meetingId}/export-captures`,
    async () => {
      manifestReads++;
      return {
        meetingId,
        complete: true,
        captures: [{ id: captureId, version: 2, state: "partial", coverage: "known_gaps" }],
      };
    },
  );
  ingest.get(
    `/api/v3/workspaces/${actor.workspaceId}/captures/${captureId}/transcript`,
    async () => ({ totalSegments: 0, segments: [], nextCursor: null }),
  );
  try {
    const workspaceOrigin = await workspace.listen({ host: "127.0.0.1", port: 0 }),
      ingestOrigin = await ingest.listen({ host: "127.0.0.1", port: 0 }),
      source = new HttpExportSources(workspaceOrigin, ingestOrigin, keys.privateKey, kid);
    const evidence = await source.load(actor, meetingId);
    assert.equal(evidence.reviewed.agendas[0]?.title, "Owner-approved agenda");
    assert.equal(workspaceReads, 2);
    assert.equal(manifestReads, 2);
    allowed = false;
    await assert.rejects(
      source.authorize(actor, meetingId),
      (error) => error instanceof AppError && error.status === 403,
    );
  } finally {
    await Promise.all([workspace.close(), ingest.close()]);
  }
});
