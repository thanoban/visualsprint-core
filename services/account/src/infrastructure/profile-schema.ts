import { pgTable, uuid, text, timestamp, bigint } from "drizzle-orm/pg-core";
export const verifiedProfiles = pgTable("verified_profiles", {
  userId: uuid("user_id").primaryKey(),
  subject: text("subject").notNull(),
  verifiedEmail: text("verified_email"),
  providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
  requestSequence: bigint("request_sequence", { mode: "number" }).notNull(),
  appliedSequence: bigint("applied_sequence", { mode: "number" }).notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
});
