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
import type { ConnectionStatus, CalendarProviderName } from "../domain/records.js";
import type { DomainEvent } from "@visualsprint/contracts";
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
