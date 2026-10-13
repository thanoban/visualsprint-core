import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  bigserial,
  bigint,
} from "drizzle-orm/pg-core";
import type { ConnectionStatus, CalendarProviderName } from "../domain/records.js";
import type { DomainEvent } from "@visualsprint/contracts";
import type { CalendarSync } from "../domain/sync.js";
import type { CalendarMeeting } from "@visualsprint/contracts";
import type { CaptureIntent } from "../application/calendar-captures.js";
export const calendarDeletions = pgTable(
  "calendar_deletion_requests",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const suppressedOccurrences = pgTable(
  "calendar_suppressed_occurrences",
  {
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    calendarId: text("calendar_id").notNull(),
    sourceKey: text("source_key").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.connectionId, t.calendarId, t.sourceKey] })],
);
export const captureTasks = pgTable(
  "calendar_capture_tasks",
  {
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    occurrenceId: uuid("occurrence_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    grantId: uuid("grant_id").notNull(),
    target: jsonb("target").$type<CalendarMeeting>().notNull(),
    enabled: boolean("enabled").notNull(),
    attempt: integer("attempt").notNull().default(1),
    key: text("key"),
    intent: jsonb("intent").$type<CaptureIntent>(),
    intentFingerprint: text("intent_fingerprint"),
    captureId: uuid("capture_id"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.connectionId, t.occurrenceId] })],
);
export const syncs = pgTable(
  "calendar_syncs",
  {
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    operationGrantId: uuid("operation_grant_id"),
    calendarId: text("calendar_id").notNull(),
    connectionVersion: integer("connection_version").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    state: text("state").$type<CalendarSync["state"]>().notNull(),
    cursor: text("cursor"),
    cursorHashes: jsonb("cursor_hashes").$type<string[]>().notNull(),
    pageCount: integer("page_count").notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    incremental: boolean("incremental").notNull().default(false),
    signalRevision: bigint("signal_revision", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const connections = pgTable(
  "connections",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    provider: text("provider").$type<CalendarProviderName>().notNull(),
    status: text("status").$type<ConnectionStatus>().notNull(),
    calendarId: text("calendar_id").notNull(),
    calendarName: text("calendar_name").notNull(),
    version: integer("version").notNull().default(1),
    oauthHash: text("oauth_hash").notNull(),
    oauthCipher: text("oauth_cipher"),
    oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }).notNull(),
    tokenCipher: text("token_cipher"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    exchangeAt: timestamp("exchange_at", { withTimezone: true }),
    errorCode: text("error_code"),
    grantId: uuid("grant_id"),
    automatic: boolean("automatic").notNull().default(false),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    connectionId: uuid("connection_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.actorId, t.key] })],
);
export const outbox = pgTable(
  "outbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    event: jsonb("event").$type<DomainEvent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
