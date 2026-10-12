import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type { CalendarAuthority } from "../application/ports.js";
export class AccountCalendars implements CalendarAuthority {
  constructor(
    private readonly baseUrl: string,
    private readonly privateKey: CryptoKey,
    private readonly keyId: string,
  ) {
    const url = new URL(baseUrl);
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
          ["127.0.0.1", "localhost"].includes(url.hostname)
        ))
    )
      throw new Error("INVALID_ACCOUNT_ORIGIN");
  }
  private async call(actor: Actor, path: string, body: unknown) {
    const token = await serviceToken({
      caller: "integration",
      audience: "account",
      actor,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await fetch(
        new URL(`/internal/workspaces/${actor.workspaceId}/${path}`, this.baseUrl),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(3000),
        },
      );
    } catch {
      throw new AppError("ACCOUNT_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403, 404].includes(response.status))
        throw new AppError("FORBIDDEN", response.status);
      throw new AppError("ACCOUNT_UNAVAILABLE", 503);
    }
    try {
      return await boundedJson(response, 32000);
    } catch {
      throw new AppError("ACCOUNT_UNAVAILABLE", 503);
    }
  }
  async requireActive(actor: Actor) {
    z.object({ active: z.literal(true) }).parse(
      await this.call(actor, "membership", { userId: actor.actorId }),
    );
  }
  async operation(actor: Actor) {
    return z.object({ connectionId: id }).parse(await this.call(actor, "automation/operation", {}));
  }
  async disableGrant(actor: Actor, connectionId: string) {
    await this.call(actor, "automation/disable-connection", { connectionId });
  }
}
