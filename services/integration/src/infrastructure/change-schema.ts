import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { CalendarChangeRound } from "../domain/changes.js";
export const calendarCheckpoints = pgTable(
  "calendar_sync_checkpoints",
  {
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    calendarId: text("calendar_id").notNull(),
    connectionVersion: integer("connection_version").notNull(),
    sourceCursor: text("source_cursor"),
    generation: uuid("generation").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    lastFullAt: timestamp("last_full_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.connectionId, t.calendarId] })],
);
export const calendarChangeRounds = pgTable(
  "calendar_change_rounds",
  {
    workspaceId: uuid("workspace_id").notNull(),
    syncId: uuid("sync_id").notNull(),
    phase: text("phase").$type<CalendarChangeRound["phase"]>().notNull(),
    sourceCursor: text("source_cursor"),
    pageCursor: text("page_cursor"),
    candidateCursor: text("candidate_cursor"),
    baseGeneration: uuid("base_generation"),
    changed: boolean("changed").notNull().default(false),
    pageCount: integer("page_count").notNull().default(0),
    cursorHashes: jsonb("cursor_hashes").$type<string[]>().notNull().default([]),
    errorCode: text("error_code"),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.syncId] })],
);
export const calendarSyncSignals = pgTable(
  "calendar_sync_signals",
  {
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.connectionId] })],
);
