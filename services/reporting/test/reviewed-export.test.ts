import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { render, evidenceFingerprint } from "../src/domain/export.js";
import { workspaceExportContext } from "../src/application/reviewed-context.js";
import { fullEvidence } from "./fixtures/evidence.js";
test("text and versioned JSON distinguish accepted human history from approved agendas and unknown external status", () => {
  const evidence = fullEvidence(),
    output = render(evidence, "text"),
    json = JSON.parse(render(evidence, "json"));
  assert.match(output, /Human state=completed/);
  assert.match(output, /External status: unknown/);
  assert.match(output, /Evidence=changed/);
  assert.match(output, /partial=true/);
  assert.match(output, /Owner-reviewed agendas \(not generated preparation drafts\)/);
  assert.match(output, /Owner-approved agenda/);
  assert.equal(json.schemaVersion, 2);
  assert.equal(json.generatedDrafts, "not_included");
  assert.equal(json.externalTaskVerification, "not_included");
  assert.equal(json.reviewed.complete, true);
  assert.equal(json.reviewed.commitments[0].statusSource, "human_review");
});
test("accepted corrections, human status, citation availability and approved agenda versions all invalidate artifacts", () => {
  const original = fullEvidence(),
    fingerprint = evidenceFingerprint(original);
  for (const change of [
    (value: typeof original) => {
      value.reviewed.commitments[0]!.version++;
    },
    (value: typeof original) => {
      value.reviewed.commitments[0]!.text = "Correction";
    },
    (value: typeof original) => {
      value.reviewed.commitments[0]!.state = "open";
    },
    (value: typeof original) => {
      value.reviewed.decisions[0]!.evidenceStatus = "unavailable";
    },
    (value: typeof original) => {
      value.reviewed.agendas[0]!.version++;
    },
    (value: typeof original) => {
      value.reviewed.agendas[0]!.body = "Reviewed new plan";
    },
  ]) {
    const modified = structuredClone(original);
    change(modified);
    assert.notEqual(evidenceFingerprint(modified), fingerprint);
  }
  assert.throws(
    () =>
      render({ ...original, reviewed: { ...original.reviewed, meetingId: randomUUID() } }, "text"),
    /EXPORT_SOURCE_CHANGED/,
  );
});
test("strict reviewed context rejects fabricated approval, wrong-kind state, duplicate IDs and missing complete marker", () => {
  const context = fullEvidence().reviewed;
  assert.equal(workspaceExportContext.safeParse(context).success, true);
  for (const modified of [
    { ...context, complete: false },
    { ...context, agendas: [{ ...context.agendas[0], reviewed: false }] },
    { ...context, commitments: [{ ...context.commitments[0], statusSource: "provider" }] },
    { ...context, decisions: [{ ...context.decisions[0], state: "completed" }] },
    { ...context, agendas: [{ ...context.agendas[0], meetingId: randomUUID() }] },
    { ...context, decisions: [context.decisions[0], context.decisions[0]] },
  ])
    assert.equal(workspaceExportContext.safeParse(modified).success, false);
});
