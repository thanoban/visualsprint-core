import type { Actor } from "@visualsprint/platform";
import type { Scope, SourceVersion } from "../domain/evidence.js";
import type { EmbeddedChunk, EvidenceChunk } from "../domain/indexing.js";

export interface Embeddings {
  embed(texts: string[]): Promise<number[][]>;
}
export type IndexJob = {
  workspaceId: string;
  id: string;
  ownerId: string;
  sessionId: string;
  scope: Scope;
  sourceFingerprint: string;
  sourceVersions: SourceVersion[];
  status: "queued" | "running" | "complete" | "failed";
  cursor: number;
  totalChunks: number;
  attempts: number;
  failures: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
  errorCode: string | null;
  createdAt: Date;
};
export interface VectorIndexes {
  load(actor: Actor, jobId: string): Promise<IndexJob | null>;
  create(
    actor: Actor,
    key: string,
    input: {
      scope: Scope;
      sourceFingerprint: string;
      sourceVersions: SourceVersion[];
      totalChunks: number;
    },
  ): Promise<IndexJob>;
  claim(workspaceId: string, jobId: string): Promise<IndexJob | null>;
  stage(job: IndexJob, chunks: EmbeddedChunk[], finished: boolean): Promise<boolean>;
  fail(job: IndexJob, code: string, transient: boolean): Promise<void>;
  latest(actor: Actor, scope: Scope, sourceFingerprint: string): Promise<IndexJob | null>;
  search(
    actor: Actor,
    jobId: string,
    meetingIds: string[],
    queryVector: number[],
    query: string,
  ): Promise<EvidenceChunk[]>;
  purgeMeeting(workspaceId: string, meetingId: string): Promise<void>;
  due(): Promise<{ workspaceId: string; id: string }[]>;
}
