import test from "node:test";
import assert from "node:assert/strict";
import { agendaContent, agendaCorrection, agendaDeletion } from "../src/agenda-model.js";
import { exportArtifact } from "../src/export-model.js";
import { exportFixture } from "./fixtures/reviewed-export.js";
test("agenda writes require explicit review and exact optimistic revisions", () => {
  const body = { title: " Reviewed ", body: " Text ", confirmed: true, expectedMeetingVersion: 2 };
  assert.deepEqual(agendaContent.parse(body), { ...body, title: "Reviewed", body: "Text" });
  assert.equal(agendaContent.safeParse({ ...body, confirmed: false }).success, false);
  assert.equal(agendaContent.safeParse({ ...body, body: " " }).success, false);
  assert.equal(agendaCorrection.safeParse({ ...body, expectedVersion: 0 }).success, false);
  assert.equal(
    agendaDeletion.safeParse({
      confirmed: true,
      expectedVersion: 1,
      expectedMeetingVersion: 2,
      body: "injected",
    }).success,
    false,
  );
});
test("schema2 export preserves all reviewed content/proofs while schema1 remains explicitly legacy", () => {
  const value = exportFixture(),
    parsed = exportArtifact.parse(value);
  assert.deepEqual(parsed, value);
  const legacy = {
    schemaVersion: 1,
    meetingId: value.meetingId,
    version: 1,
    title: value.title,
    notes: value.notes,
    captures: [],
  };
  assert.deepEqual(exportArtifact.parse(legacy), legacy);
});
test("malformed complete snapshots and injected export fields are rejected rather than stripped", () => {
  const value = exportFixture();
  for (const modified of [
    { ...value, secret: "must not be silently stripped" },
    { ...value, reviewed: { ...value.reviewed, complete: false } },
    { ...value, reviewed: { ...value.reviewed, meetingVersion: 2 } },
    {
      ...value,
      reviewed: { ...value.reviewed, agendas: [{ ...value.reviewed.agendas[0], reviewed: false }] },
    },
    {
      ...value,
      reviewed: {
        ...value.reviewed,
        decisions: [{ ...value.reviewed.decisions[0], kind: "commitment" }],
      },
    },
    {
      ...value,
      reviewed: {
        ...value.reviewed,
        commitments: [{ ...value.reviewed.commitments[0], externalStatus: "done" }],
      },
    },
    {
      ...value,
      reviewed: {
        ...value.reviewed,
        commitments: [{ ...value.reviewed.commitments[0], dueDate: "2026-02-30" }],
      },
    },
    {
      ...value,
      reviewed: {
        ...value.reviewed,
        commitments: [{ ...value.reviewed.commitments[0], evidenceStatus: "current" }],
      },
    },
  ])
    assert.equal(exportArtifact.safeParse(modified).success, false);
});
