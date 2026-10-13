import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { AuthorizedSources } from "../src/infrastructure/sources.js";
const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "session" };
const meetingId = randomUUID(),
  captureId = randomUUID(),
  segmentId = randomUUID();
const current = {
  id: captureId,
  meetingId,
  version: 3,
  state: "complete",
  coverage: "no_detected_gaps",
  createdAt: new Date().toISOString(),
};
const row = {
  id: segmentId,
  revision: 2,
  startMs: 0,
  endMs: 2000,
  text: "We chose PostgreSQL",
  speakerLabel: null,
  finalized: true,
};
async function fixture(change?: "revision" | "cursor" | "forbidden") {
  const { privateKey } = await generateKeyPair("EdDSA");
  return new AuthorizedSources(
    {
      account: "http://127.0.0.1:1",
      workspace: "http://127.0.0.1:2",
      ingest: "http://127.0.0.1:3",
    },
    privateKey,
    "fixture",
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("membership")) return Response.json({ active: true });
      if (url.pathname.endsWith("intelligence-context"))
        return change === "forbidden"
          ? new Response(null, { status: 403 })
          : Response.json({ meetings: [{ id: meetingId, version: 1, title: "Call", notes: "" }] });
      if (url.pathname.endsWith(`/meetings/${meetingId}/captures`)) return Response.json([current]);
      if (url.pathname.endsWith("transcript"))
        return Response.json({
          captureId,
          coverage: current.coverage,
          totalSegments: change === "cursor" ? 2 : 1,
          segments: [row],
          nextCursor: change === "cursor" ? `0:${segmentId}` : null,
        });
      return Response.json({ ...current, version: change === "revision" ? 4 : 3 });
    },
  );
}
test("authorized source read preserves current human segment revision and checks aggregate stability", async () => {
  const sources = await fixture();
  const result = await sources.read(actor, { kind: "meeting", id: meetingId });
  assert.equal(result.evidence[0]!.revision, 2);
  assert.equal(result.versions[0]!.coverage, "complete");
  await assert.rejects(
    (await fixture("revision")).read(actor, { kind: "meeting", id: meetingId }),
    /SOURCE_CHANGED/,
  );
});
test("permission failure and malformed repeating transcript pages fail closed", async () => {
  await assert.rejects(
    (await fixture("forbidden")).read(actor, { kind: "meeting", id: meetingId }),
    /SOURCE_FORBIDDEN/,
  );
  await assert.rejects(
    (await fixture("cursor")).read(actor, { kind: "meeting", id: meetingId }),
    /SOURCE_CHANGED|SOURCE_UNAVAILABLE/,
  );
  const operationGrantId = randomUUID();
  await assert.rejects(
    (await fixture()).read(
      { ...actor, operationGrantId, sessionId: `operation:${operationGrantId}` },
      { kind: "meeting", id: meetingId },
    ),
    /FORBIDDEN/,
  );
});
