import { z } from "zod";
import { id } from "@visualsprint/contracts";
export const actionSource = z
  .object({
    meetingId: id,
    revision: z.number().int().positive(),
    commitment: z.object({ id, version: z.number().int().positive() }).strict().optional(),
  })
  .strict();
export const acceptedActionCommitment = z.object({
  id,
  meetingId: id,
  kind: z.literal("commitment"),
  version: z.number().int().positive(),
  title: z.string().max(250),
  text: z.string().max(12000),
  dueDate: z.string().nullable(),
  state: z.enum(["open", "completed", "cancelled"]),
  humanReviewed: z.literal(true),
  evidenceStatus: z.enum(["current", "changed", "unavailable"]),
  sourcePartial: z.boolean(),
});
export const actionConnection = z.object({
  id,
  provider: z.enum(["jira", "github", "linear"]),
  destination: z.string(),
  status: z.enum(["configured", "disconnected"]),
  version: z.number().int().positive(),
});
export const externalTaskStatus = z
  .object({
    operationId: id,
    externalId: z.string().min(1).max(200),
    state: z.string().max(80),
    status: z.string().max(200),
    updatedAt: z.string().max(100),
  })
  .strict();
export const actionDraft = z.object({
  connectionId: id,
  provider: z.enum(["jira", "github", "linear"]),
  destination: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_./:-]+$/),
  payload: z.object({
    title: z.string().min(1).max(250),
    description: z.string().max(12000),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  }),
  source: actionSource,
});
export const reviewedAction = z.object({
  id,
  workspaceId: id,
  ownerId: id,
  version: z.number().int().positive(),
  state: z.enum(["draft", "approved", "revoked"]),
  input: actionDraft,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  approvalId: id.nullable(),
});
export const workflowOperation = z.object({
  id,
  actionId: id,
  state: z.enum([
    "queued",
    "dispatching",
    "unknown",
    "reconciling",
    "confirmed",
    "rejected",
    "cancelled",
  ]),
  externalId: z.string().nullable(),
  errorCode: z.string().nullable(),
  version: z.number().int().positive(),
});
export function operationMessage(state: z.infer<typeof workflowOperation>["state"]) {
  switch (state) {
    case "queued":
      return "Queued for execution; no external result is confirmed yet.";
    case "dispatching":
      return "Sending the approved action; do not create a replacement.";
    case "unknown":
    case "reconciling":
      return "The external result is unconfirmed. VisualSprint is checking for the existing task before any retry.";
    case "confirmed":
      return "External task creation confirmed.";
    case "rejected":
      return "The approved action was not accepted by the connector.";
    case "cancelled":
      return "Execution cancelled before a confirmed external result.";
  }
}
