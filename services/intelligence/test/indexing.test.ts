import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chunkEvidence, validateEmbedding } from "../src/domain/indexing.js";
import { AzureEmbeddings } from "../src/infrastructure/azure-embeddings.js";
import { validateMatches } from "../src/application/indexing.js";
const evidence = {
  meetingId: randomUUID(),
  captureId: randomUUID(),
  segmentId: randomUUID(),
  revision: 3,
  startMs: 0,
  endMs: 3000,
  text: "A😀B".repeat(8000),
  speakerLabel: null,
};
test("embedding chunks preserve all text, original correction IDs and Unicode boundaries", () => {
  const chunks = chunkEvidence([evidence]);
  assert.equal(chunks.map((row) => row.text).join(""), evidence.text);
  assert(chunks.length > 1);
  for (const chunk of chunks) {
    assert(Buffer.byteLength(chunk.text, "utf8") <= 6000);
    assert.equal(evidence.text.slice(chunk.characterStart, chunk.characterEnd), chunk.text);
    assert.equal(chunk.revision, 3);
    assert.equal(chunk.captureId, evidence.captureId);
  }
  validateMatches(chunks, { versions: [], evidence: [evidence] });
  assert.throws(
    () => validateMatches([{ ...chunks[0]!, revision: 2 }], { versions: [], evidence: [evidence] }),
    /INDEX_SOURCE_MISMATCH/,
  );
});
test("embedding vectors enforce the qualified 1536 dimensions and nonzero finite values", () => {
  const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
  validateEmbedding(vector);
  for (const invalid of [
    vector.slice(1),
    Array(1536).fill(0),
    [Infinity, ...vector.slice(1)],
    [NaN, ...vector.slice(1)],
  ])
    assert.throws(() => validateEmbedding(invalid), /INVALID_EMBEDDING/);
});
test("Azure embedding adapter fixes origin/dimensions and restores provider response order", async () => {
  const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
  const adapter = new AzureEmbeddings(
    "https://fixture.openai.azure.com",
    "qualified-embedding-small",
    async () => "fixture",
    async (url, options) => {
      assert.equal(String(url), "https://fixture.openai.azure.com/openai/v1/embeddings");
      assert.equal(options?.redirect, "error");
      const body = JSON.parse(String(options?.body));
      assert.equal(body.dimensions, 1536);
      assert.equal(body.encoding_format, "float");
      assert.equal(body.model, "qualified-embedding-small");
      assert.deepEqual(body.input, ["one", "two"]);
      return Response.json({
        data: [
          { index: 1, embedding: vector },
          { index: 0, embedding: vector },
        ],
      });
    },
  );
  assert.equal((await adapter.embed(["one", "two"])).length, 2);
  await assert.rejects(adapter.embed(["x".repeat(6001)]), /INVALID_EMBEDDING_INPUT/);
  await assert.rejects(adapter.embed(Array(17).fill("text")), /INVALID_EMBEDDING_INPUT/);
});
test("duplicate vectors and malformed provider response cannot silently misassociate evidence", async () => {
  const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
  const adapter = new AzureEmbeddings(
    "https://fixture.openai.azure.com",
    "small",
    async () => "fixture",
    async () =>
      Response.json({
        data: [
          { index: 0, embedding: vector },
          { index: 0, embedding: vector },
        ],
      }),
  );
  await assert.rejects(adapter.embed(["one", "two"]), /INVALID_EMBEDDING/);
});
