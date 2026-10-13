import type { Evidence } from "./evidence.js";

export const embeddingDimensions = 1536;
export type EvidenceChunk = Evidence & {
  chunkIndex: number;
  characterStart: number;
  characterEnd: number;
};
export type EmbeddedChunk = EvidenceChunk & { embedding: number[] };

export function validateEmbedding(vector: number[]): void {
  if (
    vector.length !== embeddingDimensions ||
    vector.some((value) => !Number.isFinite(value)) ||
    !vector.some((value) => value !== 0)
  )
    throw new Error("INVALID_EMBEDDING");
}
// UTF-8 byte limits are conservative for the embedding token ceiling. Split on
// code-point boundaries, not UTF-16 surrogate pairs. Never discard source text.
export function chunkEvidence(evidence: Evidence[], maximumBytes = 6000): EvidenceChunk[] {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 4 || maximumBytes > 6000)
    throw new Error("INVALID_CHUNK_LIMIT");
  const chunks: EvidenceChunk[] = [];
  for (const row of evidence) {
    let text = "",
      bytes = 0,
      start = 0,
      index = 0;
    const emit = () => {
      if (!text) return;
      chunks.push({
        ...row,
        text,
        chunkIndex: index++,
        characterStart: start,
        characterEnd: start + text.length,
      });
      start += text.length;
      text = "";
      bytes = 0;
    };
    for (const character of row.text) {
      const size = Buffer.byteLength(character, "utf8");
      if (bytes + size > maximumBytes) emit();
      text += character;
      bytes += size;
    }
    emit();
  }
  if (chunks.length > 10_000) throw new Error("EVIDENCE_TOO_LARGE");
  return chunks;
}
