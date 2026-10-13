import { z } from "zod";
import { boundedJson } from "@visualsprint/platform";
import type {
  CalendarPushProvider,
  PushAttempt,
  PushResult,
} from "../application/calendar-push.js";
import { OAuthCalendarProvider } from "./oauth-calendar.js";
export class HttpCalendarPush implements CalendarPushProvider {
  constructor(
    private readonly provider: "google" | "microsoft",
    private readonly calendars: OAuthCalendarProvider,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async create(
    accessToken: string,
    input: { id: string; calendarId: string; callback: string; proof: string; expiresAt: Date },
  ): Promise<PushResult> {
    if (
      this.provider === "microsoft" &&
      !(await this.calendars.resolveCalendar(accessToken, input.calendarId)).primary
    )
      return { state: "failed", code: "CALENDAR_PUSH_UNSUPPORTED" };
    const url =
      this.provider === "google"
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/watch`
        : "https://graph.microsoft.com/v1.0/subscriptions";
    let response: Response;
    try {
      response = await this.transport(url, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify(
          this.provider === "google"
            ? {
                id: input.id,
                type: "web_hook",
                address: input.callback,
                token: input.proof,
                expiration: String(input.expiresAt.getTime()),
              }
            : {
                changeType: "created,updated,deleted",
                notificationUrl: input.callback,
                resource: "/me/events",
                expirationDateTime: input.expiresAt.toISOString(),
                clientState: input.proof,
                includeResourceData: false,
              },
        ),
      });
    } catch {
      return { state: "unknown" };
    }
    if ([400, 401, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      return { state: "failed", code: "CALENDAR_PUSH_CONFIGURATION" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { state: "unknown" };
    }
    try {
      const body = await boundedJson(response, 32000);
      if (this.provider === "google") {
        const result = z
          .object({
            id: z.string(),
            resourceId: z.string().min(1).max(2000),
            expiration: z.coerce.number().int().positive(),
          })
          .parse(body);
        if (result.id !== input.id || result.expiration > input.expiresAt.getTime())
          return { state: "unknown" };
        return {
          state: "active",
          externalId: result.id,
          resourceId: result.resourceId,
          expiresAt: new Date(result.expiration),
        };
      }
      const result = z
        .object({
          id: z.string().min(1).max(2000),
          expirationDateTime: z.string().datetime({ offset: true }),
          clientState: z.string().optional(),
          resource: z.string(),
        })
        .parse(body);
      const expiresAt = new Date(result.expirationDateTime);
      if (
        expiresAt > input.expiresAt ||
        result.resource.replace(/^\//, "") !== "me/events" ||
        (result.clientState && result.clientState !== input.proof)
      )
        return { state: "unknown" };
      return { state: "active", externalId: result.id, resourceId: null, expiresAt };
    } catch {
      return { state: "unknown" };
    }
  }
  private async known(
    accessToken: string,
    attempt: PushAttempt,
    renew: boolean,
  ): Promise<PushResult> {
    if (this.provider !== "microsoft" || !attempt.externalId) return { state: "unknown" };
    let response: Response;
    try {
      response = await this.transport(
        `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(attempt.externalId)}`,
        {
          method: renew ? "PATCH" : "GET",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(8000),
          ...(renew
            ? {
                body: JSON.stringify({
                  expirationDateTime: attempt.requestedExpiresAt.toISOString(),
                }),
              }
            : {}),
        },
      );
    } catch {
      return { state: "unknown" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { state: "unknown" };
    }
    try {
      const body = z
        .object({
          id: z.string(),
          resource: z.string(),
          expirationDateTime: z.string().datetime({ offset: true }),
        })
        .parse(await boundedJson(response, 32000));
      const expiresAt = new Date(body.expirationDateTime);
      if (
        body.id !== attempt.externalId ||
        body.resource.replace(/^\//, "") !== "me/events" ||
        expiresAt > attempt.requestedExpiresAt
      )
        return { state: "unknown" };
      return { state: "active", externalId: body.id, resourceId: null, expiresAt };
    } catch {
      return { state: "unknown" };
    }
  }
  // Missing Google channel lookup or unknown Graph creation ID is never no-create evidence.
  lookup(accessToken: string, attempt: PushAttempt) {
    return this.known(accessToken, attempt, false);
  }
  renew(accessToken: string, attempt: PushAttempt) {
    return this.known(accessToken, attempt, true);
  }
}
