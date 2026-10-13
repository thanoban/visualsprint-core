import { pgTable, uuid, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
export const exports = pgTable(
  "exports",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    format: text("format").$type<"text" | "json">().notNull(),
    state: text("state")
      .$type<"queued" | "running" | "complete" | "failed" | "blocked" | "expired" | "deleted">()
      .notNull(),
    attempts: integer("attempts").notNull().default(0),
    version: integer("version").notNull().default(1),
    fingerprint: text("fingerprint"),
    content: text("content"),
    errorCode: text("error_code"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const deletionTombstones = pgTable(
  "deletion_tombstones",
  {
    workspaceId: uuid("workspace_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.meetingId] })],
);
