import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type { CalendarCaptures, CaptureIntent } from "../application/calendar-captures.js";
const view = z.object({ id, state: z.string().max(40), stopRequested: z.boolean() });
export class IngestCalendars implements CalendarCaptures {
  constructor(
    private readonly origin: string,
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
      throw new Error("INVALID_INGEST_ORIGIN");
  }
  private async call(actor: Actor, path: string, body: unknown, key?: string) {
    const token = await serviceToken({
      caller: "integration",
      audience: "ingest",
      actor,
      privateKey: this.key,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await fetch(
        new URL(`/internal/workspaces/${actor.workspaceId}/${path}`, this.origin),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(key ? { "idempotency-key": key } : {}),
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(4000),
        },
      );
    } catch {
      throw new AppError("CALENDAR_CAPTURE_RESPONSE_UNKNOWN", 503);
    }
    if (!response.ok) {
      const parsed = z
        .object({ code: z.string().regex(/^[A-Z0-9_]{1,80}$/) })
        .safeParse(await boundedJson(response, 16000).catch(() => null));
      throw new AppError(
        parsed.success ? parsed.data.code : "INGEST_UNAVAILABLE",
        [400, 401, 403, 404, 409].includes(response.status) ? response.status : 503,
      );
    }
    return boundedJson(response, 48000);
  }
  async request(actor: Actor, key: string, input: CaptureIntent) {
    return view.parse(await this.call(actor, "calendar-captures", input, key));
  }
  async command(actor: Actor, key: string, cancel: boolean) {
    return z
      .object({ capture: view.nullable(), fenced: z.boolean() })
      .parse(await this.call(actor, "calendar-commands", { key, cancel })).capture;
  }
}
