import { test } from "node:test";
import assert from "node:assert/strict";
import { extractionDetail, validateExtractionScope } from "../src/capture-extraction-model.js";
const meetingId = "55555555-5555-4555-8555-555555555555",
  captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fixture = () => ({
  id: "99999999-9999-4999-8999-999999999999",
  meetingId,
  captureId,
  transcriptRevision: 4,
  status: "complete",
  errorCode: null,
  createdAt: "2026-10-16T00:00:00Z",
  result: {
    claims: [
      {
        kind: "decision",
        text: "Choose Postgres",
        citation: {
          meetingId,
          captureId,
          segmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          revision: 2,
        },
      },
    ],
    partial: false,
    unsupported: false,
    reviewRequired: true,
    sourceFingerprint: "hash",
    sourceVersions: [{ meetingId, version: 1, captureId, captureVersion: 4, coverage: "complete" }],
  },
});
test("automatic draft requires exact finalized generation and keeps actual segment revision", () => {
  const value = validateExtractionScope(extractionDetail.parse(fixture()), meetingId);
  assert.equal(value.result?.claims[0]?.citation.revision, 2);
  const wrong = fixture();
  wrong.result.sourceVersions[0]!.captureVersion = 3;
  assert.throws(() => validateExtractionScope(extractionDetail.parse(wrong), meetingId));
});
test("foreign citations and unreviewable result states fail closed", () => {
  const wrong = fixture();
  wrong.result.claims[0]!.citation.meetingId = "66666666-6666-4666-8666-666666666666";
  assert.throws(() => validateExtractionScope(extractionDetail.parse(wrong), meetingId));
  const stale = fixture();
  stale.status = "invalidated";
  assert.throws(() => validateExtractionScope(extractionDetail.parse(stale), meetingId));
  assert.equal(
    extractionDetail.safeParse({
      ...fixture(),
      result: { ...fixture().result, reviewRequired: false },
    }).success,
    false,
  );
});
