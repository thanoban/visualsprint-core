import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { CaptureState, DomainEvent } from "@visualsprint/contracts";
import type { Coverage } from "../domain/capture.js";

export const meetingDeletions = pgTable(
  "meeting_deletions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    deletionId: uuid("deletion_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.meetingId] })],
);
export const requests = pgTable(
  "capture_requests",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    operationGrantId: uuid("operation_grant_id"),
    meetingVersion: integer("meeting_version").notNull(),
    joinUrl: text("join_url").notNull(),
    maxSeconds: integer("max_seconds").notNull(),
    state: text("state").$type<CaptureState>().notNull().default("scheduled"),
    version: integer("version").notNull().default(1),
    ready: boolean("ready").notNull().default(false),
    quotaState: text("quota_state")
      .$type<"pending" | "held" | "settled" | "released">()
      .notNull()
      .default("pending"),
    coverage: text("coverage").$type<Coverage>().notNull().default("unknown"),
    transcriptHealth: text("transcript_health")
      .$type<"unknown" | "receiving" | "paused" | "ended">()
      .notNull()
      .default("unknown"),
    errorCode: text("error_code"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    attemptId: uuid("attempt_id").notNull(),
    providerId: uuid("provider_id"),
    dispatchAt: timestamp("dispatch_at", { withTimezone: true }),
    dispatchNotBefore: timestamp("dispatch_not_before", { withTimezone: true })
      .notNull()
      .defaultNow(),
    departedAt: timestamp("departed_at", { withTimezone: true }),
    providerDone: boolean("provider_done").notNull().default(false),
    lastStatusAt: timestamp("last_status_at", { withTimezone: true }),
    lastTranscriptAt: timestamp("last_transcript_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] })],
);
export const directory = pgTable("attempt_directory", {
  attemptId: uuid("attempt_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  requestId: uuid("request_id").notNull(),
});
export const segments = pgTable(
  "transcript_segments",
  {
    workspaceId: uuid("workspace_id").notNull(),
    requestId: uuid("request_id").notNull(),
    id: uuid("id").notNull(),
    revision: integer("revision").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    text: text("text").notNull(),
    speakerLabel: text("speaker_label"),
    finalized: boolean("finalized").notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.requestId, table.id] })],
);
export const calendarTombstones = pgTable(
  "calendar_capture_tombstones",
  {
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    key: text("key").notNull(),
    grantId: uuid("grant_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.ownerId, t.key] })],
);
export const commands = pgTable(
  "commands",
  {
    workspaceId: uuid("workspace_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    requestId: uuid("request_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.actorId, table.key] })],
);
export const inbox = pgTable(
  "webhook_inbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    source: text("source").notNull(),
    messageId: text("message_id").notNull(),
    digest: text("digest").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.source, table.messageId] })],
);
export const outbox = pgTable(
  "outbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    event: jsonb("event").$type<DomainEvent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] })],
);
