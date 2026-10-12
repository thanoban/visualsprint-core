import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { id, eventEnvelope } from "@visualsprint/contracts";
import { AppError, type Actor, type Identity } from "@visualsprint/platform";
import { mayChangeMembership } from "../domain/membership.js";
import type { AccountRepository, AccountTransaction } from "./ports.js";
import { reservationFailure } from "../domain/usage.js";

const keySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export class AccountService {
  constructor(
    private readonly repository: AccountRepository,
    private readonly defaultCellId: string,
  ) {
    if (!/^[a-z0-9-]{1,100}$/.test(defaultCellId)) throw new Error("INVALID_CELL_CONFIGURATION");
  }
  private async session(tx: AccountTransaction, sessionId: string) {
    if (await tx.sessionRevoked(sessionId)) throw new AppError("UNAUTHENTICATED", 401);
  }
  private async access(tx: AccountTransaction, actor: Actor) {
    if (actor.operationGrantId) {
      const grant = await tx.grant(actor.operationGrantId);
      if (
        actor.sessionId !== `operation:${actor.operationGrantId}` ||
        !grant?.active ||
        grant.ownerId !== actor.actorId ||
        grant.capability !== "calendar_capture"
      )
        throw new AppError("FORBIDDEN", 403);
    } else {
      if (actor.sessionId.startsWith("operation:")) throw new AppError("FORBIDDEN", 403);
      await this.session(tx, actor.sessionId);
    }
    const membership = await tx.membership(actor.actorId);
    const workspace = await tx.workspace(actor.workspaceId);
    if (!membership?.active || !workspace || workspace.blocked)
      throw new AppError("FORBIDDEN", 403);
    return { membership, workspace };
  }
  me(identity: Identity) {
    return this.repository.identity(identity, async (tx) => {
      await this.session(tx, identity.sessionId);
      return { userId: tx.actorId, workspaces: await tx.workspaces() };
    });
  }
  createWorkspace(identity: Identity, key: string, body: unknown) {
    const input = z
      .object({ name: z.string().trim().min(1).max(200) })
      .strict()
      .parse(body);
    keySchema.parse(key);
    return this.repository.identity(identity, async (tx) => {
      await this.session(tx, identity.sessionId);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["workspace.create", input]))
        .digest("hex");
      return tx.command(key, fingerprint, async () => {
        const workspaceId = randomUUID();
        await tx.setWorkspace(workspaceId);
        const workspace = await tx.addWorkspace({
          id: workspaceId,
          creatorId: tx.actorId,
          name: input.name,
          cellId: this.defaultCellId,
          blocked: false,
        });
        await tx.addOwner(workspace.id);
        await tx.emit(
          eventEnvelope.parse({
            eventId: randomUUID(),
            type: "workspace.created.v1",
            schemaVersion: 1,
            workspaceId,
            aggregateId: workspaceId,
            aggregateVersion: 1,
            occurredAt: new Date().toISOString(),
            traceId: randomBytes(16).toString("hex"),
            actorId: tx.actorId,
            references: [],
          }),
        );
        return workspace;
      });
    });
  }
  directory(actor: Actor) {
    this.userOnly(actor);
    return this.repository.actor(actor, async (tx) => {
      const { membership, workspace } = await this.access(tx, actor);
      return { cellId: workspace.cellId, membershipVersion: membership.version };
    });
  }
  checkMember(actor: Actor, userId: string) {
    if (actor.operationGrantId && userId !== actor.actorId) throw new AppError("FORBIDDEN", 403);
    id.parse(userId);
    return this.repository.actor(actor, async (tx) => {
      await this.access(tx, actor);
      if (!(await tx.membership(userId))?.active) throw new AppError("FORBIDDEN", 403);
      return { active: true as const };
    });
  }
  members(actor: Actor) {
    this.userOnly(actor);
    return this.repository.actor(actor, async (tx) => {
      await this.access(tx, actor);
      return tx.members();
    });
  }
  changeMember(actor: Actor, key: string, body: unknown) {
    this.userOnly(actor);
    const input = z
      .object({ userId: id, active: z.boolean(), expectedVersion: z.number().int().nonnegative() })
      .strict()
      .parse(body);
    keySchema.parse(key);
    return this.repository.actor(actor, async (tx) => {
      const { membership } = await this.access(tx, actor);
      if (!mayChangeMembership(membership.role, input.userId === actor.actorId, !input.active))
        throw new AppError("FORBIDDEN", 403);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["membership.change", actor.workspaceId, input]))
        .digest("hex");
      return tx.command(key, fingerprint, async () => {
        const member = await tx.changeMembership(input.userId, input.active, input.expectedVersion);
        await tx.emit(
          eventEnvelope.parse({
            eventId: randomUUID(),
            type: "membership.changed.v1",
            schemaVersion: 1,
            workspaceId: actor.workspaceId,
            aggregateId: input.userId,
            aggregateVersion: member.version,
            occurredAt: new Date().toISOString(),
            traceId: randomBytes(16).toString("hex"),
            actorId: actor.actorId,
            references: [],
          }),
        );
        return member;
      });
    });
  }
  private userOnly(actor: Actor) {
    if (actor.operationGrantId || actor.sessionId.startsWith("operation:"))
      throw new AppError("FORBIDDEN", 403);
  }
  automationGrants(actor: Actor) {
    this.userOnly(actor);
    return this.repository.actor(actor, async (tx) => {
      await this.access(tx, actor);
      return tx.grants();
    });
  }
  changeAutomationGrant(actor: Actor, key: string, body: unknown, revoke = false) {
    this.userOnly(actor);
    keySchema.parse(key);
    const input = revoke
      ? z.object({ grantId: id, expectedVersion: z.number().int().positive() }).strict().parse(body)
      : z
          .object({ connectionId: id, consent: z.literal(true) })
          .strict()
          .parse(body);
    return this.repository.actor(actor, async (tx) => {
      await this.access(tx, actor);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["automation.grant", actor.workspaceId, revoke, input]))
        .digest("hex");
      const result = await tx.command(key, fingerprint, async () => {
        const record =
          "grantId" in input
            ? await tx.revokeGrant(input.grantId, input.expectedVersion)
            : await tx.createGrant(input.connectionId);
        await tx.emit(
          eventEnvelope.parse({
            eventId: randomUUID(),
            type: "automation.grant.changed.v1",
            schemaVersion: 1,
            workspaceId: actor.workspaceId,
            aggregateId: record.id,
            aggregateVersion: record.version,
            occurredAt: new Date().toISOString(),
            traceId: randomBytes(16).toString("hex"),
            actorId: actor.actorId,
            references: [{ kind: "connection", id: record.connectionId }],
          }),
        );
        return record;
      });
      const current = await tx.grant(result.id);
      if (!current || current.ownerId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
      return current;
    });
  }
  logout(identity: Identity) {
    return this.repository.identity(identity, async (tx) => {
      await tx.revokeSession(identity.sessionId);
      return { revoked: true };
    });
  }
  reserveCapture(actor: Actor, body: unknown) {
    const input = z
      .object({ requestId: id, maxSeconds: z.number().int().min(1).max(14400) })
      .strict()
      .parse(body);
    return this.repository.actor(actor, async (tx) => {
      await this.access(tx, actor);
      await tx.lockUsage();
      const old = await tx.reservation(input.requestId);
      if (old) {
        if (old.ownerId !== actor.actorId || old.maxSeconds !== input.maxSeconds)
          throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        return old;
      }
      const failure = reservationFailure(await tx.usage(), input.maxSeconds);
      if (failure) throw new AppError(failure, failure === "CONCURRENCY_LIMIT" ? 429 : 402);
      const reservation = await tx.reserve(input.requestId, input.maxSeconds);
      await this.usageEvent(tx, actor, "usage.reserved.v1", input.requestId, reservation.version);
      return reservation;
    });
  }
  captureReservation(actor: Actor, body: unknown) {
    const { requestId } = z.object({ requestId: id }).strict().parse(body);
    return this.repository.actor(actor, async (tx) => {
      const record = await tx.reservation(requestId);
      if (!record) return null;
      if (record.ownerId !== actor.actorId) throw new AppError("FORBIDDEN", 403);
      // Cleanup-only capability: no meeting/member content and no entitlement mutation.
      return { state: record.state, maxSeconds: record.maxSeconds };
    });
  }
  settleCapture(actor: Actor, body: unknown, release = false) {
    const input = release
      ? z
          .object({ requestId: id, confirmedNoCapture: z.literal(true) })
          .strict()
          .parse(body)
      : z
          .object({ requestId: id, seconds: z.number().int().min(0).max(604800) })
          .strict()
          .parse(body);
    const seconds = "seconds" in input ? input.seconds : 0;
    const state = release ? "released" : "settled";
    return this.repository.actor(actor, async (tx) => {
      // Only signed Ingest calls reach this method. Cleanup must still work after
      // the user logs out or loses membership; it never grants data access.
      await tx.lockUsage();
      const old = await tx.reservation(input.requestId);
      if (!old || old.ownerId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
      if (old.state === state && old.chargedSeconds === seconds) return old;
      if (old.state !== "held") throw new AppError("RESERVATION_CONFLICT", 409);
      const reservation = await tx.finishReservation(input.requestId, state, seconds);
      await this.usageEvent(
        tx,
        actor,
        release ? "usage.released.v1" : "usage.settled.v1",
        input.requestId,
        reservation.version,
      );
      return reservation;
    });
  }
  private usageEvent(
    tx: AccountTransaction,
    actor: Actor,
    type: "usage.reserved.v1" | "usage.settled.v1" | "usage.released.v1",
    requestId: string,
    version: number,
  ) {
    return tx.emit(
      eventEnvelope.parse({
        eventId: randomUUID(),
        type,
        schemaVersion: 1,
        workspaceId: actor.workspaceId,
        aggregateId: requestId,
        aggregateVersion: version,
        occurredAt: new Date().toISOString(),
        traceId: randomBytes(16).toString("hex"),
        actorId: actor.actorId,
        references: [{ kind: "capture", id: requestId }],
      }),
    );
  }
}
