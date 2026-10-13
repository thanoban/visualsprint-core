import type { Actor } from "@visualsprint/platform";
import type { Evidence } from "../domain/export.js";
export interface EvidenceSource {
  authorize(actor: Actor, meetingId: string): Promise<void>;
  load(actor: Actor, meetingId: string): Promise<Evidence>;
}
export type ExportJob = {
  workspaceId: string;
  id: string;
  meetingId: string;
  ownerId: string;
  sessionId: string;
  format: "text" | "json";
  state: "queued" | "running" | "complete" | "failed" | "blocked" | "expired" | "deleted";
  version: number;
  attempts: number;
  fingerprint: string | null;
  content: string | null;
  errorCode: string | null;
  leaseToken: string | null;
  expiresAt: Date;
};
export interface ExportRepository {
  create(
    actor: Actor,
    key: string,
    input: { meetingId: string; format: "text" | "json" },
    now: Date,
  ): Promise<ExportJob>;
  get(workspaceId: string, id: string): Promise<ExportJob | undefined>;
  claim(workspaceId: string, id: string, now: Date): Promise<ExportJob | undefined>;
  finish(
    job: ExportJob,
    result: {
      state: "complete" | "failed" | "blocked" | "queued";
      content?: string;
      fingerprint?: string;
      errorCode?: string;
    },
    now: Date,
  ): Promise<void>;
  remove(
    workspaceId: string,
    deletionId: string,
    input: { meetingId: string; sourceVersion: number },
  ): Promise<void>;
  due(): Promise<{ workspaceId: string; id: string }[]>;
  expire(now: Date): Promise<void>;
}
