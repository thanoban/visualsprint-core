import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, serviceToken, type Actor } from "@visualsprint/platform";
import type { MeetingAuthority, UsageAuthority } from "../application/ports.js";

export class Authorities implements MeetingAuthority, UsageAuthority {
  constructor(
    private readonly workspaceUrl: string,
    private readonly accountUrl: string,
    private readonly privateKey: CryptoKey,
    private readonly keyId: string,
  ) {
    for (const origin of [workspaceUrl, accountUrl]) {
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
  }
  private async call(
    actor: Actor,
    audience: "workspace" | "account",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await serviceToken({
      caller: "ingest",
      audience,
      actor,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await fetch(
        new URL(
          `/internal/workspaces/${actor.workspaceId}/${path}`,
          audience === "workspace" ? this.workspaceUrl : this.accountUrl,
        ),
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.timeout(3000),
        },
      );
    } catch {
      throw new AppError("AUTHORITY_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      if ([401, 403, 404, 402, 409, 429].includes(response.status))
        throw new AppError(
          response.status === 402
            ? "USAGE_EXHAUSTED"
            : response.status === 429
              ? "CAPTURE_LIMIT"
              : "AUTHORITY_REJECTED",
          response.status,
        );
      throw new AppError("AUTHORITY_UNAVAILABLE", 503);
    }
    try {
      return await response.json();
    } catch {
      throw new AppError("AUTHORITY_UNAVAILABLE", 503);
    }
  }
  async capture(actor: Actor, meetingId: string) {
    return z
      .object({
        meetingId: id,
        ownerId: id,
        joinUrl: z.string().url(),
        version: z.number().int().positive(),
      })
      .parse(
        await this.call(actor, "workspace", `meetings/${id.parse(meetingId)}/capture-context`),
      );
  }
  async read(actor: Actor, meetingId: string) {
    await this.call(actor, "workspace", `meetings/${id.parse(meetingId)}/evidence-context`);
  }
  async manage(actor: Actor, meetingId: string) {
    await this.call(actor, "workspace", `meetings/${id.parse(meetingId)}/manage-context`);
  }
  async reserve(actor: Actor, requestId: string, maxSeconds: number) {
    return z
      .object({ state: z.enum(["held", "settled", "released"]) })
      .parse(await this.call(actor, "account", "usage/reserve", { requestId, maxSeconds })).state;
  }
  async release(actor: Actor, requestId: string) {
    await this.call(actor, "account", "usage/release", { requestId, confirmedNoCapture: true });
  }
  async settle(actor: Actor, requestId: string, seconds: number) {
    await this.call(actor, "account", "usage/settle", { requestId, seconds });
  }
}
