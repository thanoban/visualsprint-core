import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { TokenVault } from "./ports.js";
const token = z
  .string()
  .min(8)
  .max(8192)
  .refine((v) => !/[\r\n\x00]/.test(v));
export const connectorConfiguration = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("jira"),
      cloudId: id,
      projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/),
      issueTypeId: z.string().regex(/^[0-9]{1,30}$/),
      credential: token,
    })
    .strict(),
  z
    .object({
      provider: z.literal("github"),
      repository: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)
        .refine((v) => v.split("/").every((part) => ![".", ".."].includes(part))),
      credential: token,
    })
    .strict(),
  z
    .object({
      provider: z.literal("linear"),
      teamId: id,
      authMode: z.enum(["oauth", "api_key"]),
      credential: token,
    })
    .strict(),
]);
export const executionInput = z
  .object({
    operationId: id,
    approvalId: id,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    connectionId: id,
    provider: z.enum(["jira", "github", "linear"]),
    destination: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_./:-]+$/),
    payload: z
      .object({
        title: z.string().min(1).max(250),
        description: z.string().max(12000),
        dueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
      })
      .strict(),
    source: z.object({
      meetingId: id,
      revision: z.number().int().positive(),
      commitment: z.object({ id, version: z.number().int().positive() }).strict().optional(),
    }).strict(),
  })
  .strict();
export type ExecutionIntent = z.infer<typeof executionInput>;
type CredentialFree<T> = T extends unknown ? Omit<T, "credential"> : never;
export type ConnectionConfig = CredentialFree<z.infer<typeof connectorConfiguration>>;
export type ActionConnection = {
  workspaceId: string;
  id: string;
  ownerId: string;
  provider: ExecutionIntent["provider"];
  destination: string;
  configuration: ConnectionConfig;
  credentialCipher: string | null;
  status: "configured" | "disconnected";
  version: number;
};
export type ActionExecution = {
  workspaceId: string;
  id: string;
  ownerId: string;
  sessionId: string;
  approvalId: string;
  payloadHash: string;
  connectionId: string;
  connectionVersion: number;
  meetingId: string;
  sourceRevision: number;
  provider: ExecutionIntent["provider"];
  payload: ExecutionIntent | null;
  state: "prepared" | "dispatching" | "confirmed" | "rejected" | "unknown" | "deleted";
  externalId: string | null;
  errorCode: string | null;
  version: number;
  leaseToken: string | null;
};
export type ExecutionResult =
  | { state: "confirmed"; externalId: string }
  | { state: "rejected"; code: string }
  | { state: "unknown" }
  | { state: "pending" };
export interface WorkflowApproval {
  proof(actor: Actor, operationId: string): Promise<ExecutionIntent>;
  reference?(actor: Actor, operationId: string): Promise<ExecutionIntent>;
}
export interface ActionAccount {
  requireActive(actor: Actor): Promise<void>;
}
export interface ActionProvider {
  create(
    connection: ActionConnection,
    credential: string,
    intent: ExecutionIntent,
  ): Promise<ExecutionResult>;
  verify(
    connection: ActionConnection,
    credential: string,
    intent: ExecutionIntent,
    externalId: string,
  ): Promise<boolean>;
  status?(
    connection: ActionConnection,
    credential: string,
    externalId: string,
  ): Promise<{ externalId: string; state: string; status: string; updatedAt: string }>;
}
export interface ActionStore {
  configure(
    actor: Actor,
    key: string,
    connection: ActionConnection,
    fingerprint: string,
  ): Promise<ActionConnection>;
  connections(actor: Actor): Promise<ActionConnection[]>;
  connection(ws: string, id: string): Promise<ActionConnection | undefined>;
  disconnect(actor: Actor, id: string, expectedVersion: number): Promise<ActionConnection>;
  prepare(
    actor: Actor,
    intent: ExecutionIntent,
    connection: ActionConnection,
  ): Promise<ActionExecution>;
  get(ws: string, id: string): Promise<ActionExecution | undefined>;
  claim(record: ActionExecution): Promise<ActionExecution | undefined>;
  finish(record: ActionExecution, result: ExecutionResult): Promise<void>;
  confirmReference(record: ActionExecution, externalId: string): Promise<void>;
  remove(
    ws: string,
    deletionId: string,
    meetingId: string,
    sourceVersion: number,
  ): Promise<"pending" | "not_required">;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",") +
    "}"
  );
}
export const actionFingerprint = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const view = (c: ActionConnection) => ({
  id: c.id,
  provider: c.provider,
  destination: c.destination,
  status: c.status,
  version: c.version,
});
const result = (e: ActionExecution): ExecutionResult =>
  e.state === "confirmed" || (e.state === "deleted" && e.externalId)
    ? { state: "confirmed", externalId: e.externalId! }
    : e.state === "rejected"
      ? { state: "rejected", code: e.errorCode ?? "ACTION_REJECTED" }
      : { state: "unknown" };
const credentialContext = (ws: string, connectionId: string) =>
  `${ws}:action-credential:${connectionId}`;
export class ActionExecutions {
  constructor(
    private readonly store: ActionStore,
    private readonly account: ActionAccount,
    private readonly approval: WorkflowApproval,
    private readonly vault: TokenVault,
    private readonly provider: ActionProvider,
  ) {}
  private async user(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    await this.account.requireActive(actor);
  }
  async configure(actor: Actor, key: string, body: unknown) {
    await this.user(actor);
    z.string()
      .min(8)
      .max(200)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .parse(key);
    const input = connectorConfiguration.parse(body),
      { credential, ...configuration } = input;
    const connectionId = randomUUID();
    const destination =
      input.provider === "jira"
        ? input.projectKey
        : input.provider === "github"
          ? input.repository
          : input.teamId;
    return view(
      await this.store.configure(
        actor,
        key,
        {
          workspaceId: actor.workspaceId,
          id: connectionId,
          ownerId: actor.actorId,
          provider: input.provider,
          destination,
          configuration: configuration as ConnectionConfig,
          credentialCipher: this.vault.seal(
            { credential },
            credentialContext(actor.workspaceId, connectionId),
          ),
          status: "configured",
          version: 1,
        },
        actionFingerprint(input),
      ),
    );
  }
  async list(actor: Actor) {
    await this.user(actor);
    return (await this.store.connections(actor)).map(view);
  }
  async disconnect(actor: Actor, connectionId: string, body: unknown) {
    await this.user(actor);
    const input = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(body);
    return view(await this.store.disconnect(actor, id.parse(connectionId), input.expectedVersion));
  }
  private async authorized(actor: Actor, input: ExecutionIntent, reference = false) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    if (reference && !this.approval.reference)
      throw new AppError("REFERENCE_AUTHORITY_UNAVAILABLE", 503);
    const [, snapshot] = await Promise.all([
      this.account.requireActive(actor),
      reference
        ? this.approval.reference!(actor, input.operationId)
        : this.approval.proof(actor, input.operationId),
    ]);
    const proof = executionInput.parse(snapshot);
    const { operationId, approvalId, payloadHash, ...draft } = input;
    if (actionFingerprint(draft) !== payloadHash || canonical(proof) !== canonical(input))
      throw new AppError("APPROVAL_PAYLOAD_MISMATCH", 409);
    const connection = await this.store.connection(actor.workspaceId, input.connectionId);
    if (
      !connection ||
      connection.ownerId !== actor.actorId ||
      connection.status !== "configured" ||
      connection.provider !== input.provider ||
      connection.destination !== input.destination
    )
      throw new AppError("ACTION_CONNECTION_UNAVAILABLE", 409);
    return connection;
  }
  private credential(connection: ActionConnection) {
    if (!connection.credentialCipher) throw new AppError("ACTION_CONNECTION_UNAVAILABLE", 409);
    return z
      .object({ credential: token })
      .strict()
      .parse(
        this.vault.open(
          connection.credentialCipher,
          credentialContext(connection.workspaceId, connection.id),
        ),
      ).credential;
  }
  async execute(actor: Actor, body: unknown) {
    const input = executionInput.parse(body),
      connection = await this.authorized(actor, input);
    const prepared = await this.store.prepare(actor, input, connection);
    if (prepared.state !== "prepared") return result(prepared);
    const claimed = await this.store.claim(prepared);
    if (!claimed) return result((await this.store.get(actor.workspaceId, input.operationId))!);
    try {
      const current = await this.authorized(actor, input);
      if (current.version !== claimed.connectionVersion)
        throw new AppError("ACTION_CONNECTION_CHANGED", 409);
      const outcome = await this.provider.create(current, this.credential(current), input);
      await this.store.finish(claimed, outcome);
    } catch (error) {
      await this.store.finish(
        claimed,
        error instanceof AppError && [401, 403, 404, 409].includes(error.status)
          ? { state: "rejected", code: "ACTION_PERMISSION_CHANGED" }
          : { state: "unknown" },
      );
    }
    return result((await this.store.get(actor.workspaceId, input.operationId))!);
  }
  async reconcile(actor: Actor, operationId: string, body: unknown) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    const input = executionInput.parse(body);
    if (input.operationId !== id.parse(operationId))
      throw new AppError("EXECUTION_ID_MISMATCH", 409);
    const existing = await this.store.get(actor.workspaceId, input.operationId);
    if (!existing || existing.ownerId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
    const {
      operationId: unused,
      approvalId: unusedApproval,
      payloadHash: unusedHash,
      ...draft
    } = input;
    if (
      existing.approvalId !== input.approvalId ||
      existing.payloadHash !== input.payloadHash ||
      actionFingerprint(draft) !== existing.payloadHash ||
      (existing.payload && actionFingerprint(existing.payload) !== actionFingerprint(input))
    )
      throw new AppError("EXECUTION_PAYLOAD_MISMATCH", 409);
    return result(existing);
  }
  async reference(actor: Actor, operationId: string, body: unknown) {
    await this.user(actor);
    const input = z
      .object({
        externalId: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_-]+$/),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(body);
    const existing = await this.store.get(actor.workspaceId, id.parse(operationId));
    if (
      !existing ||
      existing.ownerId !== actor.actorId ||
      !existing.payload ||
      !["dispatching", "unknown"].includes(existing.state)
    )
      throw new AppError("ACTION_REFERENCE_NOT_ALLOWED", 409);
    const connection = await this.authorized(actor, existing.payload, true);
    if (
      !(await this.provider.verify(
        connection,
        this.credential(connection),
        existing.payload,
        input.externalId,
      ))
    )
      throw new AppError("ACTION_REFERENCE_MISMATCH", 409);
    await this.authorized(actor, existing.payload, true);
    await this.store.confirmReference(existing, input.externalId);
    return result((await this.store.get(actor.workspaceId, operationId))!);
  }
  async taskStatus(actor: Actor, operationId: string) {
    await this.user(actor);
    const existing = await this.store.get(actor.workspaceId, id.parse(operationId));
    if (
      !existing ||
      existing.ownerId !== actor.actorId ||
      !existing.payload ||
      existing.state !== "confirmed" ||
      !existing.externalId
    )
      throw new AppError("NOT_FOUND", 404);
    if (!this.provider.status) throw new AppError("TASK_STATUS_UNAVAILABLE", 503);
    const connection = await this.authorized(actor, existing.payload, true);
    const status = await this.provider.status(
      connection,
      this.credential(connection),
      existing.externalId,
    );
    await this.authorized(actor, existing.payload, true);
    const current = await this.store.get(actor.workspaceId, operationId);
    if (current?.state !== "confirmed") throw new AppError("NOT_FOUND", 404);
    return {
      operationId,
      ...z
        .object({
          externalId: z.string().max(200),
          state: z.string().max(80),
          status: z.string().max(200),
          updatedAt: z.string().max(100),
        })
        .strict()
        .parse(status),
    };
  }
  async delete(actor: Actor, deletionId: string, body: unknown) {
    const input = z
      .object({ meetingId: id, sourceVersion: z.number().int().positive() })
      .strict()
      .parse(body);
    const externalCleanup = await this.store.remove(
      actor.workspaceId,
      id.parse(deletionId),
      input.meetingId,
      input.sourceVersion,
    );
    return {
      deletionId,
      meetingId: input.meetingId,
      participant: "integration",
      state: "complete" as const,
      externalCleanup,
    };
  }
}
