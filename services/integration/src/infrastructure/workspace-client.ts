import { z } from "zod";
import { id, type CalendarMeeting } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type { CalendarMeetings } from "../application/ports.js";
export class WorkspaceCalendars implements CalendarMeetings {
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
          ["127.0.0.1", "localhost"].includes(url.hostname)
        ))
    )
      throw new Error("INVALID_WORKSPACE_ORIGIN");
  }
  async upsert(actor: Actor, input: CalendarMeeting) {
    const token = await serviceToken({
      caller: "integration",
      audience: "workspace",
      actor,
      privateKey: this.key,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await fetch(
        new URL(`/internal/workspaces/${actor.workspaceId}/calendar-meetings`, this.origin),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
          redirect: "error",
          signal: AbortSignal.timeout(4000),
        },
      );
    } catch {
      throw new AppError("CALENDAR_MEETING_RESPONSE_UNKNOWN", 503);
    }
    if (!response.ok) {
      const body = await boundedJson(response, 16000).catch(() => null);
      const parsed = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,80}$/) }).safeParse(body);
      throw new AppError(
        parsed.success ? parsed.data.code : "WORKSPACE_UNAVAILABLE",
        [401, 403, 404, 409].includes(response.status) ? response.status : 503,
      );
    }
    try {
      return z
        .object({ id, version: z.number().int().positive() })
        .parse(await boundedJson(response, 48000));
    } catch {
      throw new AppError("CALENDAR_MEETING_RESPONSE_UNKNOWN", 503);
    }
  }
}
