import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PreparationDraft } from "../domain/preparation.js";
import type { SourceVersion } from "../domain/evidence.js";
import type { PreparationInput } from "../application/preparation-jobs.js";
export const preparationJobs = pgTable(
  "preparation_jobs",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    input: jsonb("input").$type<PreparationInput>().notNull(),
    sourceVersions: jsonb("source_versions").$type<SourceVersion[]>().notNull(),
    status: text("status")
      .$type<"queued" | "running" | "complete" | "failed" | "invalidated">()
      .notNull(),
    attempts: integer("attempts").notNull(),
    result: jsonb("result").$type<PreparationDraft>(),
    commitmentsFingerprint: text("commitments_fingerprint"),
    errorCode: text("error_code"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const preparationCommands = pgTable(
  "preparation_commands",
  {
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    jobId: uuid("job_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.ownerId, t.key] })],
);
export const preparationWork = pgTable("preparation_work_index", {
  jobId: uuid("job_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
});
