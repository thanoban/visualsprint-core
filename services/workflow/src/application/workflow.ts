import { z } from "zod";
import { AppError, type Actor } from "@visualsprint/platform";
import { type ActionInput, type Operation } from "../domain/action.js";
import { actionInput } from "./contracts.js";
import type { Authority, Connector, WorkflowRepository } from "./ports.js";
const version = z.number().int().positive();
export class WorkflowService {
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly authority: Authority,
    private readonly connector: Connector,
  ) {}
  private user(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
  }
  private async source(actor: Actor, input: ActionInput) {
    this.user(actor);
    const current = await this.authority.requireSource(actor, input.source.meetingId);
    if (current.ownerId !== actor.actorId) throw new AppError("FORBIDDEN", 403);
    if (current.version !== input.source.revision)
      throw new AppError("SOURCE_REVISION_CHANGED", 409);
    if (input.source.commitment) {
      if (!this.authority.requireCommitment) throw new AppError("COMMITMENT_AUTHORITY_UNAVAILABLE", 503);
      const accepted = await this.authority.requireCommitment(actor, input.source.commitment.id);
      if (accepted.id !== input.source.commitment.id || accepted.meetingId !== input.source.meetingId ||
          accepted.version !== input.source.commitment.version || accepted.humanReviewed !== true ||
          accepted.state !== "open" || accepted.evidenceStatus !== "current")
        throw new AppError("COMMITMENT_REVISION_CHANGED", 409);
    }
  }
  async propose(actor: Actor, key: string, body: unknown) {
    const input = actionInput.parse(body);
    await this.source(actor, input);
    return this.repository.transaction(actor, async (tx) => {
      const result = await tx.command(actor, key, { type: "propose", input }, () =>
        tx.createAction(actor, input),
      );
      return tx.action(result.id);
    });
  }
  async list(actor: Actor, meetingId?: string) {
    this.user(actor);
    if (meetingId) await this.authority.requireSource(actor, meetingId);
    const actions = await this.repository.transaction(actor, (tx) => tx.listActions(meetingId));
    if (meetingId) {
      await this.authority.requireSource(actor, meetingId);
      return actions;
    }
    for (let offset = 0; offset < actions.length; offset += 8)
      await Promise.all(
        actions
          .slice(offset, offset + 8)
          .map((action) => this.authority.requireSource(actor, action.input.source.meetingId)),
      );
    return actions;
  }
  async read(actor: Actor, id: string) {
    this.user(actor);
    const action = await this.repository.transaction(actor, (tx) => tx.action(id));
    await this.authority.requireSource(actor, action.input.source.meetingId);
    return action;
  }
  async edit(actor: Actor, id: string, key: string, body: unknown) {
    const input = z.object({ expectedVersion: version, action: actionInput }).strict().parse(body);
    await this.source(actor, input.action);
    return this.repository.transaction(actor, async (tx) => {
      const result = await tx.command(actor, key, { type: "edit", id, ...input }, () =>
        tx.changeAction(id, input.expectedVersion, input.action),
      );
      return tx.action(result.id);
    });
  }
  async approve(actor: Actor, id: string, key: string, body: unknown) {
    const input = z
      .object({ expectedVersion: version, confirmed: z.literal(true) })
      .strict()
      .parse(body);
    const action = await this.read(actor, id);
    await this.source(actor, action.input);
    return this.repository.transaction(actor, async (tx) => {
      const result = await tx.command(actor, key, { type: "approve", id, ...input }, () =>
        tx.approve(actor, id, input.expectedVersion),
      );
      return tx.action(result.id);
    });
  }
  async revoke(actor: Actor, id: string, key: string, body: unknown) {
    this.user(actor);
    const input = z.object({ expectedVersion: version }).strict().parse(body);
    return this.repository.transaction(actor, async (tx) => {
      const result = await tx.command(actor, key, { type: "revoke", id, ...input }, () =>
        tx.revoke(id, input.expectedVersion),
      );
      return tx.action(result.id);
    });
  }
  async execute(actor: Actor, id: string, key: string, body: unknown) {
    const input = z.object({ expectedVersion: version }).strict().parse(body);
    const action = await this.read(actor, id);
    await this.source(actor, action.input);
    return this.repository.transaction(actor, async (tx) => {
      const result = await tx.command(actor, key, { type: "execute", id, ...input }, () =>
        tx.createOperation(actor, id, input.expectedVersion),
      );
      return tx.operation(result.id);
    });
  }
  async status(actor: Actor, id: string) {
    this.user(actor);
    const operation = await this.repository.transaction(actor, (tx) => tx.operation(id));
    await this.authority.requireSource(actor, operation.input.source.meetingId);
    return operation;
  }
  async operations(actor: Actor, id: string) {
    await this.read(actor, id);
    return this.repository.transaction(actor, (tx) => tx.operations(id));
  }
  async proof(actor: Actor, id: string) {
    this.user(actor);
    const operation = await this.repository.transaction(actor, (tx) => tx.approvalProof(id));
    await this.source(actor, operation.input);
    return {
      operationId: operation.id,
      approvalId: operation.approvalId,
      payloadHash: operation.payloadHash,
      ...operation.input,
    };
  }
  async referenceContext(actor: Actor, id: string) {
    this.user(actor);
    const operation = await this.repository.transaction(actor, (tx) => tx.operation(id));
    if (!["unknown", "reconciling", "confirmed"].includes(operation.state))
      throw new AppError("REFERENCE_LOOKUP_NOT_AVAILABLE", 409);
    const current = await this.authority.requireSource(actor, operation.input.source.meetingId);
    if (current.ownerId !== actor.actorId) throw new AppError("FORBIDDEN", 403);
    return {
      operationId: operation.id,
      approvalId: operation.approvalId,
      payloadHash: operation.payloadHash,
      ...operation.input,
    };
  }
  async deleteMeeting(actor: Actor, deletionId: string, body: unknown) {
    const input = z
      .object({ meetingId: z.string().uuid(), sourceVersion: version })
      .strict()
      .parse(body);
    await this.repository.transaction(actor, (tx) =>
      tx.deleteMeeting(deletionId, input.meetingId, input.sourceVersion),
    );
    return {
      deletionId,
      meetingId: input.meetingId,
      participant: "workflow",
      state: "complete" as const,
    };
  }
  async work(workspaceId: string, id: string) {
    const systemActor: Actor = {
      workspaceId,
      actorId: "00000000-0000-0000-0000-000000000000",
      sessionId: "workflow-routing",
    };
    const operation = await this.repository.transaction(systemActor, (tx) => tx.claim(id));
    if (!operation) return;
    const actor: Actor = {
      workspaceId,
      actorId: operation.ownerId,
      sessionId: operation.sessionId,
    };
    const intent = {
      ...operation.input,
      operationId: operation.id,
      approvalId: operation.approvalId,
      payloadHash: operation.payloadHash,
    };
    try {
      if (operation.state === "reconciling") {
        // Reconciliation is lookup-only, not a new external write. An uncertain write still needs cleanup after revocation.
        const result = await this.connector.reconcile(actor, intent);
        if (result.state === "confirmed")
          await this.finish(actor, operation, "confirmed", result.externalId, null);
        else if (result.state === "rejected")
          await this.finish(actor, operation, "rejected", null, result.code);
        else if (result.state === "not_created") {
          try {
            await this.proof(actor, id);
            await this.finish(actor, operation, "queued", null, null);
          } catch {
            await this.finish(actor, operation, "cancelled", null, "APPROVAL_NO_LONGER_VALID");
          }
        } else await this.finish(actor, operation, "unknown", null, "EXECUTION_UNCONFIRMED");
      } else {
        try {
          await this.proof(actor, id);
        } catch (error) {
          if (error instanceof AppError && [401, 403, 404, 409].includes(error.status)) {
            await this.finish(actor, operation, "cancelled", null, error.code);
            return;
          }
          throw error;
        }
        const result = await this.connector.execute(actor, intent);
        if (result.state === "confirmed")
          await this.finish(actor, operation, "confirmed", result.externalId, null);
        else if (result.state === "rejected")
          await this.finish(actor, operation, "rejected", null, result.code);
        else await this.finish(actor, operation, "unknown", null, "EXECUTION_UNCONFIRMED");
      }
    } catch {
      await this.finish(actor, operation, "unknown", null, "EXECUTION_RESPONSE_UNKNOWN");
    }
  }
  private finish(
    actor: Actor,
    operation: Operation,
    state: Operation["state"],
    externalId: string | null,
    errorCode: string | null,
  ) {
    return this.repository.transaction(actor, (tx) =>
      tx.finish(operation, state, externalId, errorCode),
    );
  }
}
