import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
export const entitlements = pgTable("entitlements", {
  workspaceId: uuid("workspace_id").primaryKey(),
  maxConcurrent: integer("max_concurrent").notNull().default(5),
  monthlySeconds: integer("monthly_seconds").notNull().default(360000),
});
export const captureReservations = pgTable(
  "capture_reservations",
  {
    workspaceId: uuid("workspace_id").notNull(),
    requestId: uuid("request_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    maxSeconds: integer("max_seconds").notNull(),
    period: date("period")
      .notNull()
      .default(sql`date_trunc('month',now() AT TIME ZONE 'UTC')::date`),
    state: text("state").$type<"held" | "settled" | "released">().notNull().default("held"),
    chargedSeconds: integer("charged_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.requestId] })],
);
export const usageLedger = pgTable(
  "usage_ledger",
  {
    workspaceId: uuid("workspace_id").notNull(),
    requestId: uuid("request_id").notNull(),
    period: date("period").notNull(),
    seconds: integer("seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.requestId] })],
);
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  subject: text("subject").notNull().unique(),
});
export const operationGrants = pgTable(
  "operation_grants",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    capability: text("capability").$type<"calendar_capture">().notNull(),
    active: boolean("active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] })],
);
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  creatorId: uuid("creator_id").notNull(),
  name: text("name").notNull(),
  cellId: text("cell_id").notNull(),
  blocked: boolean("blocked").notNull().default(false),
});
export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").$type<"owner" | "member">().notNull(),
    active: boolean("active").notNull().default(true),
    version: integer("version").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);
export const revokedSessions = pgTable(
  "revoked_sessions",
  {
    userId: uuid("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionId] })],
);
export const commands = pgTable(
  "commands",
  {
    userId: uuid("user_id").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    response: jsonb("response").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);
export const outbox = pgTable("outbox", {
  workspaceId: uuid("workspace_id").notNull(),
  id: uuid("id").primaryKey(),
  event: jsonb("event").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});
