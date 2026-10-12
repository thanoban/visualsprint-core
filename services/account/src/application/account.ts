import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { id, eventEnvelope } from "@visualsprint/contracts";
import { AppError, type Actor, type Identity } from "@visualsprint/platform";
import { mayChangeMembership } from "../domain/membership.js";
import type { AccountRepository, AccountTransaction } from "./ports.js";

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
    await this.session(tx, actor.sessionId);
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
    return this.repository.actor(actor, async (tx) => {
      const { membership, workspace } = await this.access(tx, actor);
      return { cellId: workspace.cellId, membershipVersion: membership.version };
    });
  }
  checkMember(actor: Actor, userId: string) {
    id.parse(userId);
    return this.repository.actor(actor, async (tx) => {
      await this.access(tx, actor);
      if (!(await tx.membership(userId))?.active) throw new AppError("FORBIDDEN", 403);
      return { active: true as const };
    });
  }
  members(actor: Actor) {
    return this.repository.actor(actor, async (tx) => {
      await this.access(tx, actor);
      return tx.members();
    });
  }
  changeMember(actor: Actor, key: string, body: unknown) {
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
  logout(identity: Identity) {
    return this.repository.identity(identity, async (tx) => {
      await tx.revokeSession(identity.sessionId);
      return { revoked: true };
    });
  }
}
