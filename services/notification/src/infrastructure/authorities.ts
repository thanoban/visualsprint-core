import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type { Authority } from "../application/ports.js";
class SignedClient {
  constructor(
    private readonly origin: string,
    private readonly audience: string,
    private readonly key: CryptoKey,
    private readonly keyId: string,
  ) {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          process.env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        ))
    )
      throw new Error("INVALID_AUTHORITY_ORIGIN");
  }
  async call(actor: Actor, path: string, body?: unknown) {
    const token = await serviceToken({
      caller: "notification",
      audience: this.audience,
      actor,
      privateKey: this.key,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await fetch(new URL(path, this.origin), {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new AppError("AUTHORITY_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404].includes(response.status) ? "FORBIDDEN" : "AUTHORITY_UNAVAILABLE",
        [401, 403, 404].includes(response.status) ? response.status : 503,
      );
    }
    try {
      return await boundedJson(response, 16000);
    } catch {
      throw new AppError("AUTHORITY_UNAVAILABLE", 503);
    }
  }
}
export class NotificationAuthority implements Authority {
  private readonly account: SignedClient;
  private readonly workspace: SignedClient;
  constructor(accountOrigin: string, workspaceOrigin: string, key: CryptoKey, keyId: string) {
    this.account = new SignedClient(accountOrigin, "account", key, keyId);
    this.workspace = new SignedClient(workspaceOrigin, "workspace", key, keyId);
  }
  async requireSession(actor: Actor) {
    z.object({ active: z.literal(true) }).parse(
      await this.account.call(actor, `/internal/workspaces/${actor.workspaceId}/membership`, {
        userId: actor.actorId,
      }),
    );
  }
  private actor(workspaceId: string, userId: string, deliveryId?: string): Actor {
    return { workspaceId, actorId: userId, sessionId: `notification:${deliveryId ?? userId}` };
  }
  async profile(workspaceId: string, userId: string, deliveryId?: string) {
    return z
      .object({ active: z.literal(true), verifiedEmail: z.string().email().nullable() })
      .parse(
        await this.account.call(
          this.actor(workspaceId, userId, deliveryId),
          `/internal/workspaces/${workspaceId}/notifications/membership`,
          { userId },
        ),
      );
  }
  async source(workspaceId: string, userId: string, meetingId: string, deliveryId?: string) {
    const context = z
      .object({ meetingId: id, version: z.number().int().positive() })
      .parse(
        await this.workspace.call(
          this.actor(workspaceId, userId, deliveryId),
          `/internal/workspaces/${workspaceId}/meetings/${meetingId}/notification-context`,
        ),
      );
    if (context.meetingId !== meetingId) throw new AppError("AUTHORITY_UNAVAILABLE", 503);
    return context;
  }
}
export class DisabledEmail {
  readonly configured = false;
  async send() {
    return { state: "rejected" as const, code: "EMAIL_NOT_CONFIGURED" };
  }
  async lookup() {
    return { state: "pending" as const };
  }
}
