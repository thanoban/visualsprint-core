import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { AppError, ServiceIdentity } from "@visualsprint/platform";
import { HttpExportSources } from "../src/infrastructure/source-client.js";
import { reviewedContext } from "./fixtures/evidence.js";
async function fixture() {
  const key = await generateKeyPair("EdDSA"),
    kid = "reporting-test",
    jwk = { ...(await exportJWK(key.publicKey)), kid },
    actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "fixture" },
    meetingId = randomUUID(),
    captureId = randomUUID(),
    segmentId = randomUUID();
  const context = reviewedContext(meetingId),
    calls: string[] = [];
  let page = 0;
  const handlers = {
    context: () => Response.json(context),
    captures: () =>
      Response.json({
        meetingId,
        complete: true,
        captures: [{ id: captureId, version: 2, state: "partial", coverage: "known_gaps" }],
      }),
    segment: () => {
      page++;
      return Response.json({
        totalSegments: 1,
        segments: [
          {
            id: segmentId,
            revision: 2,
            startMs: 0,
            endMs: 1000,
            text: "Evidence text",
            speakerLabel: null,
          },
        ],
        nextCursor: null,
      });
    },
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      token = (init?.headers as Record<string, string>).authorization!.slice(7),
      audience = url.hostname === "workspace.example" ? "workspace" : "ingest";
    assert.deepEqual(
      (await new ServiceIdentity(audience, { reporting: [jwk] }).verify(token)).actor,
      actor,
    );
    assert.equal(init?.redirect, "error");
    calls.push(url.pathname);
    if (url.pathname.endsWith(`/meetings/${meetingId}`))
      return Response.json({
        id: meetingId,
        version: 1,
        title: "Private meeting",
        notes: "Notes",
        joinUrl: "must-not-export",
      });
    if (url.pathname.endsWith("/export-context")) {
      assert.ok(url.pathname.startsWith("/internal/"));
      return handlers.context();
    }
    if (url.pathname.endsWith("/export-captures")) {
      assert.ok(url.pathname.startsWith("/internal/"));
      return handlers.captures();
    }
    return handlers.segment();
  };
  return {
    actor,
    meetingId,
    captureId,
    segmentId,
    context,
    calls,
    handlers,
    pages: () => page,
    source: new HttpExportSources(
      "https://workspace.example",
      "https://ingest.example",
      key.privateKey,
      kid,
      transport,
    ),
    key,
    kid,
  };
}
test("export source uses signed normal identity and complete reviewed snapshots without private join data", async () => {
  const f = await fixture(),
    data = await f.source.load(f.actor, f.meetingId);
  assert.equal(f.pages(), 1);
  assert.equal(data.captures[0]?.segments[0]?.revision, 2);
  assert.equal(data.reviewed.commitments[0]?.state, "completed");
  assert.equal(data.reviewed.agendas[0]?.reviewed, true);
  assert.equal(JSON.stringify(data).includes("must-not-export"), false);
  assert.throws(
    () =>
      new HttpExportSources(
        "https://workspace.example/path",
        "https://ingest.example",
        f.key.privateKey,
        f.kid,
      ),
    /INVALID_SOURCE_ORIGIN/,
  );
  await assert.rejects(
    f.source.load({ ...f.actor, operationGrantId: randomUUID() }, f.meetingId),
    (error) => error instanceof AppError && error.status === 403,
  );
});
test("missing, noncomplete, cross-meeting and overbound reviewed contexts never fabricate an empty export", async () => {
  for (const mutation of [
    (value: Record<string, unknown>) => ({ ...value, complete: false }),
    (value: Record<string, unknown>) => ({ ...value, meetingId: randomUUID() }),
    (value: Record<string, unknown>) => ({ ...value, meetingVersion: 2 }),
    (value: Record<string, unknown>) => ({
      ...value,
      commitments: [{ ...(value.commitments as object[])[0], meetingId: randomUUID() }],
    }),
    (value: Record<string, unknown>) => ({ ...value, agendas: undefined }),
    (value: Record<string, unknown>) => ({
      ...value,
      commitments: Array.from({ length: 101 }, () => ({
        ...(value.commitments as object[])[0],
        id: randomUUID(),
      })),
    }),
  ]) {
    const f = await fixture();
    f.handlers.context = () => Response.json(mutation(f.context));
    await assert.rejects(f.source.load(f.actor, f.meetingId));
    assert.equal(f.pages(), 0);
  }
  const f = await fixture();
  f.handlers.context = () => new Response("", { status: 503 });
  await assert.rejects(
    f.source.load(f.actor, f.meetingId),
    (error) => error instanceof AppError && error.status === 503,
  );
});
test("current accepted citations must match exact capture and segment revisions while changed history stays labeled", async () => {
  const f = await fixture(),
    record = f.context.commitments[0]!;
  record.evidenceStatus = "current";
  record.citations = [
    {
      captureId: f.captureId,
      segmentId: f.segmentId,
      captureVersion: 2,
      revision: 2,
      coverage: "partial",
    },
  ];
  await f.source.load(f.actor, f.meetingId);
  record.citations[0]!.revision = 3;
  await assert.rejects(
    f.source.load(f.actor, f.meetingId),
    (error) => error instanceof AppError && error.code === "EXPORT_SOURCE_CHANGED",
  );
  record.evidenceStatus = "changed";
  assert.equal(
    (await f.source.load(f.actor, f.meetingId)).reviewed.commitments[0]?.evidenceStatus,
    "changed",
  );
});
test("revoked reviewed source and ongoing capture fail closed", async () => {
  const f = await fixture();
  f.handlers.context = () => new Response("", { status: 403 });
  await assert.rejects(
    f.source.load(f.actor, f.meetingId),
    (error) => error instanceof AppError && error.status === 403,
  );
  const g = await fixture();
  g.handlers.captures = () =>
    Response.json({
      meetingId: g.meetingId,
      complete: true,
      captures: [{ id: g.captureId, version: 1, state: "capturing", coverage: "unknown" }],
    });
  await assert.rejects(
    g.source.load(g.actor, g.meetingId),
    (error) => error instanceof AppError && error.code === "EXPORT_CAPTURE_NOT_FINAL",
  );
});
test("complete capture manifests reject legacy lists, wrong targets, duplicate entries and overflow", async () => {
  const f = await fixture(),
    capture = { id: f.captureId, version: 2, state: "complete", coverage: "no_detected_gaps" };
  for (const manifest of [
    [capture],
    { meetingId: f.meetingId, complete: false, captures: [] },
    { meetingId: randomUUID(), complete: true, captures: [] },
    { meetingId: f.meetingId, complete: true, captures: [capture, capture] },
    {
      meetingId: f.meetingId,
      complete: true,
      captures: Array.from({ length: 101 }, () => ({ ...capture, id: randomUUID() })),
    },
  ]) {
    f.handlers.captures = () => Response.json(manifest);
    await assert.rejects(f.source.load(f.actor, f.meetingId));
  }
  for (const code of ["CAPTURE_EXPORT_SCOPE_TOO_LARGE", "EXPORT_CONTEXT_TOO_LARGE"]) {
    f.handlers.context = () => Response.json({ code }, { status: 409 });
    await assert.rejects(f.source.load(f.actor, f.meetingId), /EXPORT_SIZE_LIMIT/);
  }
});
test("accepted corrections or capture changes during transcript loading are fenced before returning a snapshot", async () => {
  for (const target of ["accepted", "agenda", "capture", "permission"]) {
    const f = await fixture(),
      original = f.handlers.segment;
    f.handlers.segment = () => {
      const response = original();
      if (target === "accepted") f.context.commitments[0]!.version++;
      if (target === "agenda") f.context.agendas[0]!.body = "Changed agenda";
      if (target === "capture")
        f.handlers.captures = () =>
          Response.json({ meetingId: f.meetingId, complete: true, captures: [] });
      if (target === "permission") f.handlers.context = () => new Response("", { status: 403 });
      return response;
    };
    await assert.rejects(
      f.source.load(f.actor, f.meetingId),
      (error) =>
        error instanceof AppError &&
        (error.code === "EXPORT_SOURCE_CHANGED" || error.status === 403),
    );
  }
});
