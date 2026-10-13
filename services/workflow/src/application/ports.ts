import type { Actor } from "@visualsprint/platform";
import type {
  Action,
  ActionInput,
  Operation,
  ExecutionIntent,
  ExecutionResult,
  ReconciliationResult,
} from "../domain/action.js";
export interface Authority {
  requireSource(actor: Actor, meetingId: string): Promise<{ version: number; ownerId: string }>;
}
export interface Connector {
  execute(actor: Actor, intent: ExecutionIntent): Promise<ExecutionResult>;
  reconcile(actor: Actor, intent: ExecutionIntent): Promise<ReconciliationResult>;
}
export interface WorkflowTransaction {
  command(
    actor: Actor,
    key: string,
    input: unknown,
    run: () => Promise<{ id: string }>,
  ): Promise<{ id: string }>;
  createAction(actor: Actor, input: ActionInput): Promise<Action>;
  action(id: string): Promise<Action>;
  listActions(meetingId?: string): Promise<Action[]>;
  changeAction(id: string, expectedVersion: number, input: ActionInput): Promise<Action>;
  approve(actor: Actor, id: string, expectedVersion: number): Promise<Action>;
  revoke(id: string, expectedVersion: number): Promise<Action>;
  createOperation(actor: Actor, actionId: string, expectedVersion: number): Promise<Operation>;
  operation(id: string): Promise<Operation>;
  operations(actionId: string): Promise<Operation[]>;
  claim(id: string): Promise<Operation | null>;
  finish(
    operation: Operation,
    state: Operation["state"],
    externalId: string | null,
    errorCode: string | null,
  ): Promise<void>;
  approvalProof(id: string): Promise<Operation>;
  deleteMeeting(deletionId: string, meetingId: string, sourceVersion: number): Promise<void>;
}
export interface WorkflowRepository {
  transaction<T>(actor: Actor, run: (tx: WorkflowTransaction) => Promise<T>): Promise<T>;
  due(): Promise<{ workspaceId: string; operationId: string }[]>;
  reschedule(workspaceId: string, operationId: string, seconds?: number): Promise<void>;
}
