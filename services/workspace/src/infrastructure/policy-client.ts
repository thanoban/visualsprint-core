import { z } from "zod";
import { AppError, serviceToken, type Actor } from "@visualsprint/platform";
import type { PolicyAuthority } from "../application/ports.js";
import type { MeetingAccess } from "../domain/permissions.js";

export class AuthzPolicy implements PolicyAuthority {
  constructor(
    private readonly origin: string,
    private readonly privateKey: CryptoKey,
    private readonly keyId: string,
  ) {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          process.env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        ))
    )
      throw new Error("INVALID_AUTHZ_ORIGIN");
  }
  async check(
    actor: Actor,
    meetingId: string,
    access: MeetingAccess,
    relation: "can_view" | "can_manage",
  ): Promise<boolean> {
    return (await this.checkMany(actor, [{ meetingId, access, relation }]))[0]!;
  }
  async checkMany(
    actor: Actor,
    checks: { meetingId: string; access: MeetingAccess; relation: "can_view" | "can_manage" }[],
  ): Promise<boolean[]> {
    if (!checks.length) return [];
    const token = await serviceToken({
      caller: "workspace",
      audience: "authz",
      actor,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    try {
      const response = await fetch(
        new URL(`/internal/workspaces/${actor.workspaceId}/check`, this.origin),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            checks: checks.map(({ meetingId, access, relation }) => ({
              meetingId,
              ownerId: access.ownerId,
              reader: access.readerIds.includes(actor.actorId),
              blocked: access.blocked,
              activeMember: true,
              relation,
            })),
          }),
          signal: AbortSignal.timeout(3500),
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error("POLICY_UNAVAILABLE");
      return z
        .object({ allowed: z.array(z.boolean()).length(checks.length) })
        .parse(await response.json()).allowed;
    } catch {
      throw new AppError("AUTHZ_UNAVAILABLE", 503);
    }
  }
}
