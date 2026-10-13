import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { AppError, ServiceIdentity } from "@visualsprint/platform";
import { HttpExportSources } from "../src/infrastructure/source-client.js";
test("export source reads use caller-bound signed identity and page all evidence without secrets", async () => {
  const key = await generateKeyPair("EdDSA"),
    kid = "reporting-test",
    jwk = { ...(await exportJWK(key.publicKey)), kid };
  const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "fixture" },
    meetingId = randomUUID(),
    captureId = randomUUID(),
    segmentId = randomUUID();
  let pages = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      token = (init?.headers as Record<string, string>).authorization!.slice(7),
      audience = url.hostname === "workspace.example" ? "workspace" : "ingest";
    assert.deepEqual(
      (await new ServiceIdentity(audience, { reporting: [jwk] }).verify(token)).actor,
      actor,
    );
    assert.equal(init?.redirect, "error");
    if (url.pathname.endsWith("/meetings/" + meetingId))
      return Response.json({
        id: meetingId,
        version: 1,
        title: "Private meeting",
        notes: "Notes",
        joinUrl: "must-not-export",
      });
    if (url.pathname.endsWith("/captures"))
      return Response.json([
        { id: captureId, version: 2, state: "partial", coverage: "known_gaps" },
      ]);
    pages++;
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
  };
  const source = new HttpExportSources(
      "https://workspace.example",
      "https://ingest.example",
      key.privateKey,
      kid,
      transport,
    ),
    data = await source.load(actor, meetingId);
  assert.equal(pages, 1);
  assert.equal(data.captures[0]?.segments[0]?.revision, 2);
  assert.equal(JSON.stringify(data).includes("must-not-export"), false);
  assert.throws(
    () =>
      new HttpExportSources(
        "https://workspace.example/path",
        "https://ingest.example",
        key.privateKey,
        kid,
      ),
    /INVALID_SOURCE_ORIGIN/,
  );
});
test("revoked source and ongoing capture fail closed before publication", async () => {
  const key = await generateKeyPair("EdDSA"),
    actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "fixture" },
    meetingId = randomUUID();
  const revoked = new HttpExportSources(
    "https://workspace.example",
    "https://ingest.example",
    key.privateKey,
    "test",
    async () => new Response("", { status: 403 }),
  );
  await assert.rejects(
    revoked.load(actor, meetingId),
    (e) => e instanceof AppError && e.status === 403,
  );
  const ongoing = new HttpExportSources(
    "https://workspace.example",
    "https://ingest.example",
    key.privateKey,
    "test",
    async (input) =>
      String(input).endsWith("/captures")
        ? Response.json([{ id: randomUUID(), version: 1, state: "capturing", coverage: "unknown" }])
        : Response.json({ id: meetingId, version: 1, title: "Meeting", notes: "" }),
  );
  await assert.rejects(
    ongoing.load(actor, meetingId),
    (e) => e instanceof AppError && e.code === "EXPORT_CAPTURE_NOT_FINAL",
  );
});
