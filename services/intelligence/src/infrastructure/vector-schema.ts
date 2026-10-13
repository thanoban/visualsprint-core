import {
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Scope, SourceVersion } from "../domain/evidence.js";
import { validateEmbedding } from "../domain/indexing.js";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value) {
    validateEmbedding(value);
    return JSON.stringify(value);
  },
  fromDriver(value) {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "number"))
      throw new Error("INVALID_EMBEDDING");
    validateEmbedding(parsed);
    return parsed;
  },
});
export const indexJobs = pgTable(
  "vector_index_jobs",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    scope: jsonb("scope").$type<Scope>().notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    sourceVersions: jsonb("source_versions").$type<SourceVersion[]>().notNull(),
    status: text("status").$type<"queued" | "running" | "complete" | "failed">().notNull(),
    cursor: integer("cursor").notNull(),
    totalChunks: integer("total_chunks").notNull(),
    attempts: integer("attempts").notNull(),
    failures: integer("failures").notNull(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const indexCommands = pgTable(
  "vector_index_commands",
  {
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    jobId: uuid("job_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.ownerId, t.key] })],
);
export const embeddings = pgTable(
  "evidence_embeddings",
  {
    workspaceId: uuid("workspace_id").notNull(),
    indexId: uuid("index_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    captureId: uuid("capture_id").notNull(),
    segmentId: uuid("segment_id").notNull(),
    revision: integer("revision").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    characterStart: integer("character_start").notNull(),
    characterEnd: integer("character_end").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    text: text("text").notNull(),
    speakerLabel: text("speaker_label"),
    embedding: vector("embedding").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.indexId, t.ordinal] })],
);
export const vectorWork = pgTable("vector_work_index", {
  jobId: uuid("job_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
});
