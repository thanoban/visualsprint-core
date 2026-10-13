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
import type { DomainEvent } from "@visualsprint/contracts";
export const preferences = pgTable(
  "preferences",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    version: integer("version").notNull(),
    inApp: boolean("in_app").notNull(),
    email: boolean("email").notNull(),
    deliveryHourUtc: integer("delivery_hour_utc"),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);
export const commands = pgTable(
  "commands",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.key] })],
);
export const inbox = pgTable(
  "inbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    eventId: uuid("event_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.eventId] })],
);
export const deliveries = pgTable(
  "deliveries",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    userId: uuid("user_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    eventId: uuid("event_id").notNull(),
    kind: text("kind").notNull(),
    sourceVersion: integer("source_version").notNull(),
    channel: text("channel").notNull(),
    state: text("state").notNull(),
    version: integer("version").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    externalId: text("external_id"),
    errorCode: text("error_code"),
    readAt: timestamp("read_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const attempts = pgTable(
  "attempts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    deliveryId: uuid("delivery_id").notNull(),
    state: text("state").notNull(),
    externalId: text("external_id"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const outbox = pgTable(
  "outbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    event: jsonb("event").$type<DomainEvent>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const deletionTombstones = pgTable(
  "deletion_tombstones",
  {
    workspaceId: uuid("workspace_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    deletionId: uuid("deletion_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.meetingId] })],
);
export const cleanupAttempts = pgTable(
  "cleanup_attempts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    deliveryId: uuid("delivery_id").notNull(),
    deletionId: uuid("deletion_id").notNull(),
    state: text("state").notNull(),
    externalId: text("external_id"),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.deliveryId] })],
);
export const deliveryWork = pgTable("delivery_work_index", {
  workspaceId: uuid("workspace_id").notNull(),
  deliveryId: uuid("delivery_id").primaryKey(),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
});
export const eventWork = pgTable("event_work_index", {
  workspaceId: uuid("workspace_id").primaryKey(),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
});
