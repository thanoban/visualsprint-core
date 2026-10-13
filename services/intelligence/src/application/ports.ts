import type { Actor } from "@visualsprint/platform";
import type {
  Claim,
  Evidence,
  Result,
  Scope,
  Snapshot,
  SourceVersion,
} from "../domain/evidence.js";

export interface Sources {
  requireActive(actor: Actor): Promise<void>;
  read(actor: Actor, scope: Scope): Promise<Snapshot>;
}
export interface Model {
  generate(input: {
    purpose: "summary" | "answer";
    question: string | null;
    evidence: Evidence[];
  }): Promise<unknown>;
}
export type Thread = {
  workspaceId: string;
  id: string;
  ownerId: string;
  title: string;
  scope: Scope;
  version: number;
  createdAt: Date;
};
export type Job = {
  workspaceId: string;
  id: string;
  ownerId: string;
  sessionId: string;
  kind: "summary" | "answer";
  scope: Scope;
  threadId: string | null;
  question: string | null;
  retrievalMode?: "lexical" | "indexed";
  status: "queued" | "running" | "complete" | "failed" | "invalidated";
  attempts: number;
  result: Result | null;
  sourceVersions: SourceVersion[] | null;
  errorCode: string | null;
  leaseToken: string | null;
  leaseUntil: Date | null;
  createdAt: Date;
};
export interface Transaction {
  command<T>(actorId: string, key: string, input: unknown, create: () => Promise<T>): Promise<T>;
  insertThread(thread: Thread): Promise<Thread>;
  thread(id: string, ownerId: string): Promise<Thread | null>;
  threads(ownerId: string): Promise<Thread[]>;
  insertJob(job: Job): Promise<Job>;
  job(id: string, ownerId?: string): Promise<Job | null>;
  messages(threadId: string, ownerId: string): Promise<Job[]>;
  summaries(meetingId: string, ownerId: string): Promise<Job[]>;
  claim(id: string): Promise<Job | null>;
  pinSources(id: string, token: string, versions: SourceVersion[]): Promise<boolean>;
  complete(id: string, token: string, result: Result, evidence: Evidence[]): Promise<boolean>;
  fail(id: string, token: string, code: string, retry: boolean): Promise<void>;
  invalidate(id: string): Promise<void>;
  purgeMeeting(meetingId: string, deletionId: string, sourceVersion: number): Promise<void>;
}
export interface Repository {
  scoped<T>(workspaceId: string, work: (tx: Transaction) => Promise<T>): Promise<T>;
  due(): Promise<{ workspaceId: string; id: string }[]>;
}
export type ModelClaims = { claims: Claim[]; unsupported: boolean };
