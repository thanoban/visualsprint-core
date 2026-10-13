import { AppError, type Actor } from "@visualsprint/platform";
import { fingerprint, type Evidence, type Scope, type Snapshot } from "../domain/evidence.js";
import type { EvidenceChunk } from "../domain/indexing.js";
import { validateMatches } from "./indexing.js";
export interface ScopedRetriever {
  requireReady?(actor: Actor, scope: Scope): Promise<void>;
  retrieve(
    actor: Actor,
    scope: Scope,
    query: string,
    key: string,
  ): Promise<{
    sourceFingerprint: string;
    evidence: EvidenceChunk[];
    partial: boolean;
  }>;
}
export class IndexedChatEvidence {
  constructor(private readonly retriever: ScopedRetriever) {}
  async requireReady(actor: Actor, scope: Scope) {
    if (!this.retriever.requireReady) throw new AppError("RETRIEVAL_DISABLED", 503);
    await this.retriever.requireReady(actor, scope);
  }
  async select(actor: Actor, scope: Scope, question: string, jobId: string, snapshot: Snapshot) {
    const retrieved = await this.retriever.retrieve(actor, scope, question, `chat:${jobId}`);
    if (retrieved.sourceFingerprint !== fingerprint(snapshot))
      throw new AppError("SOURCE_CHANGED", 409);
    validateMatches(retrieved.evidence, snapshot);
    const authoritative = new Map(
      snapshot.evidence.map((row) => [
        `${row.meetingId}:${row.captureId}:${row.segmentId}:${row.revision}`,
        row,
      ]),
    );
    const selected: Evidence[] = [],
      seen = new Set<string>();
    let characters = 0;
    for (const match of retrieved.evidence) {
      const key = `${match.meetingId}:${match.captureId}:${match.segmentId}:${match.revision}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Multiple chunks share a segment citation. Supply its authoritative text
      // once instead of allowing a last-chunk map to falsify citation checking.
      const row = authoritative.get(key)!;
      if (selected.length >= 100 || characters + row.text.length > 60000) continue;
      selected.push(row);
      characters += row.text.length;
    }
    if (retrieved.evidence.length && !selected.length)
      throw new AppError("EVIDENCE_TOO_LARGE", 409);
    return selected;
  }
}
