import { z } from "zod";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import { id } from "@visualsprint/contracts";
import type { MembershipAuthority } from "../application/ports.js";

export class AccountMemberships implements MembershipAuthority {
  constructor(
    private readonly baseUrl: string,
    private readonly privateKey: CryptoKey,
    private readonly keyId: string,
  ) {}
  private async check(actor: Actor, userId: string): Promise<void> {
    const token = await serviceToken({
      caller: "workspace",
      audience: "account",
      actor,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await fetch(
        new URL(`/internal/workspaces/${actor.workspaceId}/membership`, this.baseUrl),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ userId }),
          redirect: "error",
          signal: AbortSignal.timeout(3000),
        },
      );
    } catch {
      throw new AppError("ACCOUNT_UNAVAILABLE", 503);
    }
    if (response.status === 401) throw new AppError("UNAUTHENTICATED", 401);
    if (response.status === 403 || response.status === 404) throw new AppError("FORBIDDEN", 403);
    if (!response.ok) throw new AppError("ACCOUNT_UNAVAILABLE", 503);
    let allowed = false;
    try {
      allowed = z.object({ active: z.literal(true) }).parse(await response.json()).active;
    } catch {
      throw new AppError("ACCOUNT_UNAVAILABLE", 503);
    }
    if (!allowed) throw new AppError("FORBIDDEN", 403);
  }
  requireActive(actor: Actor) {
    return this.check(actor, actor.actorId);
  }
  async operationConnection(actor: Actor) {
    if (!actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    const token = await serviceToken({
      caller: "workspace",
      audience: "account",
      actor,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await fetch(
        new URL(`/internal/workspaces/${actor.workspaceId}/automation/operation`, this.baseUrl),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}",
          redirect: "error",
          signal: AbortSignal.timeout(3000),
        },
      );
    } catch {
      throw new AppError("ACCOUNT_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404].includes(response.status) ? "FORBIDDEN" : "ACCOUNT_UNAVAILABLE",
        [401, 403, 404].includes(response.status) ? 403 : 503,
      );
    }
    try {
      return z.object({ connectionId: id }).parse(await boundedJson(response, 16000)).connectionId;
    } catch {
      throw new AppError("ACCOUNT_UNAVAILABLE", 503);
    }
  }
  requireMember(workspaceId: string, userId: string, delegatedBy: Actor) {
    if (workspaceId !== delegatedBy.workspaceId) throw new AppError("FORBIDDEN", 403);
    return this.check(delegatedBy, userId);
  }
}
