import {
  pgTable,
  uuid,
  integer,
  bigint,
  text,
  date,
  timestamp,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
import type { ModelReservationState, ModelOutcome, ModelPurpose } from "../domain/model-usage.js";
export const modelEntitlements = pgTable(
  "model_entitlements",
  {
    workspaceId: uuid("workspace_id").notNull(),
    purpose: text("purpose").$type<ModelPurpose>().notNull(),
    maxConcurrent: integer("max_concurrent").notNull().default(2),
    monthlyInputTokens: bigint("monthly_input_tokens", { mode: "number" })
      .notNull()
      .default(1000000),
    monthlyOutputTokens: bigint("monthly_output_tokens", { mode: "number" })
      .notNull()
      .default(100000),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.purpose] })],
);
export const modelReservations = pgTable(
  "model_reservations",
  {
    workspaceId: uuid("workspace_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    purpose: text("purpose").$type<ModelPurpose>().notNull(),
    maxInputTokens: integer("max_input_tokens").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    period: date("period").notNull(),
    state: text("state").$type<ModelReservationState>().notNull().default("held"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.reservationId] }),
    unique().on(table.workspaceId, table.operationId),
  ],
);
export const modelEstimateLedger = pgTable(
  "model_estimate_ledger",
  {
    workspaceId: uuid("workspace_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    period: date("period").notNull(),
    purpose: text("purpose").$type<ModelPurpose>().notNull(),
    estimatedInputTokens: integer("estimated_input_tokens").notNull(),
    estimatedOutputTokens: integer("estimated_output_tokens").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.reservationId] })],
);
export const modelOutcomeLedger = pgTable(
  "model_outcome_ledger",
  {
    workspaceId: uuid("workspace_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    outcome: text("outcome").$type<ModelOutcome>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.reservationId, table.outcome] })],
);
