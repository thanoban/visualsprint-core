import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bootstrap } from "../../src/bootstrap.js";
import { OpenFgaPolicy } from "../../src/policy.js";

test("real PostgreSQL-backed OpenFGA permits only current owner/readers and active members", async () => {
  const origin = "http://127.0.0.1:4180";
  const key = "local-openfga-only";
  const ids = await bootstrap(origin, key, `policy-test-${randomUUID()}`);
  try {
    const policy = new OpenFgaPolicy(origin, key, ids.storeId, ids.modelId);
    const owner = { actorId: randomUUID(), workspaceId: randomUUID(), sessionId: "owner" };
    const other = { ...owner, actorId: randomUUID() };
    const facts = {
      meetingId: randomUUID(),
      ownerId: owner.actorId,
      reader: false,
      blocked: false,
      activeMember: true,
      relation: "can_view" as const,
    };
    assert.equal(await policy.check(owner, facts), true);
    assert.equal(await policy.check(other, facts), false);
    assert.equal(await policy.check(other, { ...facts, reader: true }), true);
    assert.equal(
      await policy.check(other, { ...facts, reader: true, relation: "can_manage" }),
      false,
    );
    assert.equal(await policy.check(owner, { ...facts, relation: "can_manage" }), true);
    assert.equal(
      await policy.check(other, facts),
      false,
      "contextual grant never persists after revocation",
    );
    assert.equal(await policy.check(owner, { ...facts, activeMember: false }), false);
    assert.equal(await policy.check(owner, { ...facts, blocked: true }), false);
  } finally {
    const response = await fetch(`${origin}/stores/${ids.storeId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(response.ok, true);
  }
});
