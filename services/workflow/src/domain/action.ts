import { createHash } from "node:crypto";
export interface ActionInput {
  connectionId: string;
  provider: "jira" | "github" | "linear";
  destination: string;
  payload: { title: string; description: string; dueDate: string | null };
  source: { meetingId: string; revision: number; commitment?: { id: string; version: number } | undefined };
}
export type State = "draft" | "approved" | "revoked";
export type OperationState =
  | "queued"
  | "dispatching"
  | "unknown"
  | "reconciling"
  | "confirmed"
  | "rejected"
  | "cancelled";
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
export function fingerprint(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export interface Action {
  id: string;
  workspaceId: string;
  ownerId: string;
  version: number;
  state: State;
  input: ActionInput;
  payloadHash: string;
  approvalId: string | null;
}
export interface ExecutionIntent extends ActionInput {
  operationId: string;
  approvalId: string;
  payloadHash: string;
}
export type ExecutionResult =
  | { state: "confirmed"; externalId: string }
  | { state: "rejected"; code: string }
  | { state: "unknown" };
export type ReconciliationResult =
  | ExecutionResult
  | { state: "pending" }
  | { state: "not_created" };
export interface Operation {
  id: string;
  actionId: string;
  workspaceId: string;
  ownerId: string;
  sessionId: string;
  state: OperationState;
  approvalId: string;
  payloadHash: string;
  input: ActionInput;
  externalId: string | null;
  errorCode: string | null;
  version: number;
  leaseToken: string | null;
}
