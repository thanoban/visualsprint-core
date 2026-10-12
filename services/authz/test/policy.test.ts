import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { OpenFgaPolicy, safeOrigin } from "../src/policy.js";

test("policy rejects unsafe origins and has no unpinned model fallback", () => {
  for (const origin of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/?key=x",
  ])
    assert.throws(() => safeOrigin(origin));
  assert.throws(() => new OpenFgaPolicy("http://127.0.0.1:4180", "fixture", "latest", "latest"));
});
test("blocked or inactive meetings fail closed without contacting the engine", async () => {
  const policy = new OpenFgaPolicy(
    "http://127.0.0.1:1",
    "fixture",
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  );
  const actor = { actorId: randomUUID(), workspaceId: randomUUID(), sessionId: "session" };
  const input = {
    meetingId: randomUUID(),
    ownerId: actor.actorId,
    reader: true,
    blocked: true,
    activeMember: true,
    relation: "can_view" as const,
  };
  assert.equal(await policy.check(actor, input), false);
  assert.equal(await policy.check(actor, { ...input, blocked: false, activeMember: false }), false);
  await assert.rejects(policy.check(actor, { ...input, blocked: false }), {
    code: "AUTHZ_UNAVAILABLE",
  });
});
