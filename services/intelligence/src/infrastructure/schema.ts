import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DomainEvent } from "@visualsprint/contracts";
import type { Result, Scope, SourceVersion } from "../domain/evidence.js";
export const threads = pgTable(
  "chat_threads",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    title: text("title").notNull(),
    scope: jsonb("scope").$type<Scope>().notNull(),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const jobs = pgTable(
  "intelligence_jobs",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    kind: text("kind").$type<"summary" | "answer">().notNull(),
    scope: jsonb("scope").$type<Scope>().notNull(),
    threadId: uuid("thread_id"),
    question: text("question"),
    status: text("status")
      .$type<"queued" | "running" | "complete" | "failed" | "invalidated">()
      .notNull(),
    attempts: integer("attempts").notNull(),
    result: jsonb("result").$type<Result>(),
    sourceVersions: jsonb("source_versions").$type<SourceVersion[]>(),
    errorCode: text("error_code"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const commands = pgTable(
  "commands",
  {
    workspaceId: uuid("workspace_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    response: jsonb("response").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.actorId, t.key] })],
);
export const evidence = pgTable(
  "evidence_index",
  {
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    captureId: uuid("capture_id").notNull(),
    segmentId: uuid("segment_id").notNull(),
    revision: integer("revision").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    text: text("text").notNull(),
    speakerLabel: text("speaker_label"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.ownerId, t.meetingId, t.captureId, t.segmentId] }),
  ],
);
export const outbox = pgTable(
  "outbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    event: jsonb("event").$type<DomainEvent>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const tombstones = pgTable(
  "deletion_tombstones",
  {
    workspaceId: uuid("workspace_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    deletionId: uuid("deletion_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.meetingId] })],
);
export const workIndex = pgTable("intelligence_work_index", {
  workspaceId: uuid("workspace_id").notNull(),
  jobId: uuid("job_id").primaryKey(),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
});
