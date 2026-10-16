import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  extractionChunks,
  extractionInputBound,
  mergeExtractionClaims,
} from "../src/domain/extraction-chunks.js";
import type { Evidence } from "../src/domain/evidence.js";
function row(text: string): Evidence {
  return {
    meetingId: randomUUID(),
    captureId: randomUUID(),
    segmentId: randomUUID(),
    revision: 1,
    startMs: 0,
    endMs: 1000,
    text,
    speakerLabel: null,
  };
}
test("long evidence is partitioned deterministically without dropping or reordering a segment", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => row(`${index}: ${"text ".repeat(100)}`));
  const chunks = extractionChunks(rows);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), rows);
  assert.deepEqual(extractionChunks(rows), chunks);
  assert.ok(chunks.every((chunk) => extractionInputBound(chunk) <= 200_000));
});
test("a very long single segment preserves UTF-8 codepoints and original citation across bounded chunks", () => {
  const source = row('😀 quote\\" '.repeat(35000));
  const chunks = extractionChunks([source]);
  assert.ok(chunks.length > 1);
  assert.equal(
    chunks
      .flat()
      .map((entry) => entry.text)
      .join(""),
    source.text,
  );
  assert.ok(
    chunks
      .flat()
      .every((entry) => entry.segmentId === source.segmentId && !entry.text.includes("�")),
  );
  assert.ok(chunks.every((chunk) => extractionInputBound(chunk) <= 200_000));
});
test("oversized sources fail explicitly and an empty source makes no chunks", () => {
  assert.throws(
    () => extractionChunks([row("x".repeat(2_000_001))]),
    /PROCESSING_EVIDENCE_TOO_LARGE/,
  );
  assert.throws(
    () => extractionChunks(Array.from({ length: 10001 }, () => row(""))),
    /PROCESSING_EVIDENCE_TOO_LARGE/,
  );
  assert.deepEqual(extractionChunks([]), []);
});
test("deterministic reduction deduplicates identical claims without hiding unsupported chunks", () => {
  const evidence = row("Agreed"),
    claim = {
      kind: "decision" as const,
      text: "Agreed",
      citation: {
        meetingId: evidence.meetingId,
        captureId: evidence.captureId,
        segmentId: evidence.segmentId,
        revision: 1,
      },
    };
  assert.deepEqual(
    mergeExtractionClaims([
      { claims: [claim], unsupported: false },
      { claims: [claim], unsupported: true },
    ]),
    { claims: [claim], unsupported: true },
  );
});
