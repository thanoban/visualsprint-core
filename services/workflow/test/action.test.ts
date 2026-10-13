import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fingerprint } from "../src/domain/action.js";
import { actionInput } from "../src/application/contracts.js";
test("approval digest is canonical and binds every destination, payload and source field", () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  const input = actionInput.parse({
    connectionId: randomUUID(),
    provider: "jira",
    destination: "project/CORE",
    payload: { title: "Implement", description: "Only reviewed evidence", dueDate: null },
    source: { meetingId: randomUUID(), revision: 1 },
  });
  for (const changed of [
    { ...input, destination: "project/OTHER" },
    { ...input, payload: { ...input.payload, title: "Changed" } },
    { ...input, source: { ...input.source, revision: 2 } },
    { ...input, source: { ...input.source, commitment: { id: randomUUID(), version: 1 } } },
    { ...input, connectionId: randomUUID() },
  ])
    assert.notEqual(fingerprint(input), fingerprint(changed));
  assert.throws(() => actionInput.parse({ ...input, approved: true }));
  const accepted = { ...input, source: { ...input.source, commitment: { id: randomUUID(), version: 1 } } };
  assert.notEqual(fingerprint(accepted), fingerprint({ ...accepted, source: {
    ...accepted.source, commitment: { ...accepted.source.commitment, version: 2 },
  } }));
});
