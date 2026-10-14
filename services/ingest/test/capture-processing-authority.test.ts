import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { CaptureProcessingAuthorities } from "../src/infrastructure/capture-processing-authority.js";

test("owner metadata authority uses body-free GET on the native Workspace contract", async () => {
  const actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: "owner" };
  const meetingId = randomUUID();
  const { privateKey } = await generateKeyPair("EdDSA");
  let requests = 0;
  const transport: typeof fetch = async (input, init) => {
    requests++;
    assert.equal(
      String(input),
      `http://127.0.0.1:4102/internal/workspaces/${actor.workspaceId}/meetings/${meetingId}/manage-context`,
    );
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("content-type"), null);
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /);
    assert.equal(init?.redirect, "error");
    return Response.json({ meetingId, ownerId: actor.actorId });
  };
  const authority = new CaptureProcessingAuthorities(
    { account: "http://127.0.0.1:4101", workspace: "http://127.0.0.1:4102" },
    privateKey,
    "ingest",
    transport,
  );
  await authority.owner(actor, meetingId);
  assert.equal(requests, 1);
});
