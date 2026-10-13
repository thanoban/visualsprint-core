import { pgTable, uuid, text, integer, boolean, timestamp, primaryKey } from "drizzle-orm/pg-core";
export const calendarPushSubscriptions = pgTable(
  "calendar_push_subscriptions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    calendarId: text("calendar_id").notNull(),
    connectionVersion: integer("connection_version").notNull(),
    provider: text("provider").$type<"google" | "microsoft">().notNull(),
    state: text("state").$type<"intent" | "unknown" | "active" | "retired" | "failed">().notNull(),
    proofHash: text("proof_hash").notNull(),
    proofCipher: text("proof_cipher"),
    externalId: text("external_id"),
    resourceId: text("resource_id"),
    requestedExpiresAt: timestamp("requested_expires_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    errorCode: text("error_code"),
    renewalRequired: boolean("renewal_required").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const calendarPushRoutes = pgTable("calendar_push_route_index", {
  routeId: text("route_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  subscriptionId: uuid("subscription_id").notNull(),
  provider: text("provider").$type<"google" | "microsoft">().notNull(),
});
export const calendarPushInbox = pgTable(
  "calendar_push_inbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);
