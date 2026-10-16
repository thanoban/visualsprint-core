import type { Evidence, Claim } from "./evidence.js";

export class ExtractionLimitError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

// UTF-8 bytes are a conservative token ceiling. Leave room for adapter prompts.
export const extractionInput = (evidence: Evidence[]) => ({
  purpose: "summary" as const,
  question: null,
  evidence,
});
export const extractionInputBound = (evidence: Evidence[]) =>
  Buffer.byteLength(JSON.stringify(extractionInput(evidence)), "utf8") + 4096;
const maximumInput = 200_000;
const maximumChunks = 64;
export function extractionChunks(evidence: Evidence[]): Evidence[][] {
  if (
    evidence.length > 10_000 ||
    evidence.reduce((sum, row) => sum + Buffer.byteLength(row.text, "utf8"), 0) > 2_000_000
  )
    throw new ExtractionLimitError("PROCESSING_EVIDENCE_TOO_LARGE");
  const chunks: Evidence[][] = [];
  let pending: Evidence[] = [],
    size = extractionInputBound([]);
  const flush = () => {
    if (pending.length) chunks.push(pending);
    pending = [];
    size = extractionInputBound([]);
  };
  // Preserve source order and every character; repeated citations across chunks
  // still refer to the original immutable segment revision, never invented IDs.
  for (const row of evidence) {
    const rowSize = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (extractionInputBound([row]) <= maximumInput) {
      if (size + rowSize > maximumInput) flush();
      pending.push(row);
      size += rowSize;
    } else {
      flush();
      if (extractionInputBound([{ ...row, text: "" }]) > 70_000)
        throw new ExtractionLimitError("MODEL_INPUT_TOO_LARGE");
      let text = "",
        bytes = 0;
      for (const character of row.text) {
        const count = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
        if (bytes + count > 120_000) {
          chunks.push([{ ...row, text }]);
          text = "";
          bytes = 0;
        }
        text += character;
        bytes += count;
      }
      if (text) chunks.push([{ ...row, text }]);
      if (!text && row.text.length === 0) throw new ExtractionLimitError("MODEL_INPUT_TOO_LARGE");
    }
    if (chunks.length > maximumChunks) throw new ExtractionLimitError("EXTRACTION_CHUNK_LIMIT");
  }
  flush();
  if (
    chunks.length > maximumChunks ||
    chunks.some((chunk) => extractionInputBound(chunk) > maximumInput)
  )
    throw new ExtractionLimitError("EXTRACTION_CHUNK_LIMIT");
  return chunks;
}
export function mergeExtractionClaims(outputs: { claims: Claim[]; unsupported: boolean }[]) {
  const seen = new Set<string>(),
    claims: Claim[] = [];
  for (const output of outputs)
    for (const claim of output.claims) {
      const key = JSON.stringify([claim.kind, claim.text, claim.citation]);
      if (!seen.has(key)) {
        seen.add(key);
        claims.push(claim);
      }
    }
  if (Buffer.byteLength(JSON.stringify(claims), "utf8") > 3_000_000)
    throw new ExtractionLimitError("EXTRACTION_OUTPUT_TOO_LARGE");
  // A chunk's inability to support an answer is not silently erased by others.
  return { claims, unsupported: !outputs.length || outputs.some((output) => output.unsupported) };
}
