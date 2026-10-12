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
export const calendarMeetings = pgTable(
  "calendar_meetings",
  {
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    occurrenceId: uuid("occurrence_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    lastTitle: text("last_title").notNull(),
    status: text("status").notNull(),
    allDay: boolean("all_day").notNull(),
    declined: boolean("declined").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.connectionId, t.occurrenceId] })],
);

const scoped = () => ({
  workspaceId: uuid("workspace_id").notNull(),
  id: uuid("id").notNull(),
  ownerId: uuid("owner_id").notNull(),
});
export const customers = pgTable(
  "customers",
  { ...scoped(), name: text("name").notNull(), version: integer("version").notNull().default(1) },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const projects = pgTable(
  "projects",
  {
    ...scoped(),
    customerId: uuid("customer_id"),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const meetings = pgTable(
  "meetings",
  {
    ...scoped(),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    joinUrl: text("join_url"),
    version: integer("version").notNull().default(1),
    blocked: boolean("blocked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const readers = pgTable(
  "meeting_readers",
  {
    workspaceId: uuid("workspace_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    userId: uuid("user_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.meetingId, t.userId] })],
);
export const assignments = pgTable(
  "meeting_assignments",
  {
    workspaceId: uuid("workspace_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    projectId: uuid("project_id").notNull(),
    confirmedBy: uuid("confirmed_by").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.meetingId, t.projectId] })],
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
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const inbox = pgTable(
  "inbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    eventId: uuid("event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.eventId] })],
);
