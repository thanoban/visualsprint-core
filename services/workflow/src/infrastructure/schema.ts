import { pgTable, uuid, text, integer, jsonb, timestamp, primaryKey } from "drizzle-orm/pg-core";
import type { ActionInput } from "../domain/action.js";
import type { DomainEvent } from "@visualsprint/contracts";
export const actions = pgTable(
  "actions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    version: integer("version").notNull(),
    state: text("state").notNull(),
    input: jsonb("input").$type<ActionInput>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    approvalId: uuid("approval_id"),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const approvals = pgTable(
  "approvals",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    actionId: uuid("action_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    sourceMeetingId: uuid("source_meeting_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    input: jsonb("input").$type<ActionInput>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const operations = pgTable(
  "operations",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    actionId: uuid("action_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    approvalId: uuid("approval_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    sourceMeetingId: uuid("source_meeting_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    input: jsonb("input").$type<ActionInput>().notNull(),
    state: text("state").notNull(),
    externalId: text("external_id"),
    errorCode: text("error_code"),
    version: integer("version").notNull(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
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
    result: jsonb("result").$type<{ id: string }>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.actorId, t.key] })],
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
export const operationWork = pgTable("operation_work_index", {
  workspaceId: uuid("workspace_id").notNull(),
  operationId: uuid("operation_id").primaryKey(),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
});
export const eventWork = pgTable("event_work_index", {
  workspaceId: uuid("workspace_id").primaryKey(),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
});
export const deletionTombstones = pgTable(
  "deletion_tombstones",
  {
    workspaceId: uuid("workspace_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    deletionId: uuid("deletion_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.meetingId] })],
);
export const cleanupExecutions = pgTable(
  "cleanup_executions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    deletionId: uuid("deletion_id").notNull(),
    approvalId: uuid("approval_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    sourceMeetingId: uuid("source_meeting_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    state: text("state").notNull(),
    externalId: text("external_id"),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.operationId] })],
);
