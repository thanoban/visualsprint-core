import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { render, evidenceFingerprint, type Evidence } from "../src/domain/export.js";
import { exportInput } from "../src/application/contracts.js";
const evidence: Evidence = {
  meetingId: "11111111-1111-4111-8111-111111111111",
  version: 1,
  title: "Customer meeting",
  notes: "Owner notes",
  captures: [
    {
      id: randomUUID(),
      version: 2,
      state: "partial",
      coverage: "known_gaps",
      segments: [
        {
          id: randomUUID(),
          revision: 2,
          startMs: 0,
          endMs: 1000,
          text: "Ship Friday",
          speakerLabel: null,
        },
      ],
    },
  ],
  reviewed: {
    schemaVersion: 1,
    complete: true,
    meetingId: "11111111-1111-4111-8111-111111111111",
    meetingVersion: 1,
    decisions: [],
    commitments: [],
    agendas: [],
  },
};
test("exports carry observed coverage, evidence identity/revision and uncertain speakers", () => {
  const output = render(evidence, "text");
  assert.match(output, /coverage=known_gaps/);
  assert.match(output, /Unknown speaker/);
  assert.match(output, /revision 2/);
  assert.match(output, /not reconstructed/);
  const json = JSON.parse(render(evidence, "json"));
  assert.equal(json.schemaVersion, 2);
  assert.equal(json.captures[0].segments[0].text, "Ship Friday");
});
test("source revisions/content invalidate export fingerprint and output is bounded", () => {
  assert.notEqual(evidenceFingerprint(evidence), evidenceFingerprint({ ...evidence, version: 2 }));
  assert.notEqual(
    evidenceFingerprint(evidence),
    evidenceFingerprint({ ...evidence, notes: "Edited" }),
  );
  assert.throws(
    () => render({ ...evidence, notes: "x".repeat(2000000) }, "text"),
    /EXPORT_SIZE_LIMIT/,
  );
  assert.equal(
    exportInput.safeParse({ meetingId: randomUUID(), format: "text", ownerId: randomUUID() })
      .success,
    false,
  );
});
