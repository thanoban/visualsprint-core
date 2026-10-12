import { z } from "zod";
import { AppError, boundedJson } from "@visualsprint/platform";
import type { CalendarProvider } from "../application/ports.js";
import type { CalendarProviderName, Tokens } from "../domain/records.js";
const tokenBody = z.object({
  access_token: z.string().min(1).max(16000),
  refresh_token: z.string().min(1).max(16000).optional(),
  expires_in: z.number().int().min(1).max(86400),
  scope: z.string().max(8000).optional(),
  token_type: z.string().optional(),
});
const identifier = z.string().min(1).max(2000);
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const MS_SCOPE = "offline_access https://graph.microsoft.com/Calendars.Read";
function providerPayload<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError("CALENDAR_PROVIDER_UNAVAILABLE", 503);
  return result.data;
}
export class OAuthCalendarProvider implements CalendarProvider {
  constructor(
    private readonly provider: CalendarProviderName,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly transport: typeof fetch = (input, init) => fetch(input, init),
    private readonly now: () => Date = () => new Date(),
  ) {
    const uri = new URL(redirectUri);
    if (
      !clientId.trim() ||
      !clientSecret.trim() ||
      uri.username ||
      uri.password ||
      uri.search ||
      uri.hash ||
      (uri.protocol !== "https:" &&
        !(
          process.env.NODE_ENV !== "production" &&
          uri.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(uri.hostname)
        ))
    )
      throw new Error("INVALID_CALENDAR_OAUTH_CONFIGURATION");
  }
  authorizationUrl(state: string, challenge: string) {
    const url = new URL(
      this.provider === "google"
        ? "https://accounts.google.com/o/oauth2/v2/auth"
        : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    for (const [key, value] of Object.entries({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: this.provider === "google" ? GOOGLE_SCOPE : MS_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value);
    if (this.provider === "google") {
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
    }
    return url.href;
  }
  private async tokens(
    parameters: Record<string, string>,
    previousRefresh?: string,
  ): Promise<Tokens> {
    const endpoint =
      this.provider === "google"
        ? "https://oauth2.googleapis.com/token"
        : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    let response: Response;
    try {
      response = await this.transport(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...parameters,
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new AppError("OAUTH_RESPONSE_UNKNOWN", 503);
    }
    let body: unknown;
    try {
      body = await boundedJson(response, 64000);
    } catch {
      throw new AppError("OAUTH_RESPONSE_UNKNOWN", 503);
    }
    if (!response.ok) {
      const error = z.object({ error: z.string().max(100) }).safeParse(body);
      if (error.success && error.data.error === "invalid_grant")
        throw new AppError("REAUTH_REQUIRED", 401);
      if (
        error.success &&
        ["invalid_client", "unauthorized_client", "invalid_scope"].includes(error.data.error)
      )
        throw new AppError("CALENDAR_CONFIGURATION", 503);
      throw new AppError("CALENDAR_PROVIDER_UNAVAILABLE", 503);
    }
    const result = tokenBody.safeParse(body);
    if (
      !result.success ||
      (result.data.token_type && result.data.token_type.toLowerCase() !== "bearer")
    )
      throw new AppError("OAUTH_RESPONSE_UNKNOWN", 503);
    const token = result.data;
    const refreshToken = token.refresh_token ?? previousRefresh;
    if (!refreshToken) throw new AppError("OFFLINE_ACCESS_REQUIRED", 409);
    if (token.scope) {
      const scopes = token.scope.split(/\s+/);
      const allowed =
        this.provider === "google"
          ? scopes.includes(GOOGLE_SCOPE)
          : scopes.some((scope) =>
              ["calendars.read", "https://graph.microsoft.com/calendars.read"].includes(
                scope.toLowerCase(),
              ),
            );
      if (!allowed) throw new AppError("CALENDAR_SCOPE_MISSING", 403);
    }
    return {
      accessToken: token.access_token,
      refreshToken,
      expiresAt: new Date(this.now().getTime() + token.expires_in * 1000),
    };
  }
  exchange(code: string, verifier: string) {
    return this.tokens({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri,
    });
  }
  refresh(refreshToken: string) {
    return this.tokens(
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        ...(this.provider === "microsoft" ? { scope: MS_SCOPE } : {}),
      },
      refreshToken,
    );
  }
  private async data(url: URL, accessToken: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(this.provider === "microsoft"
            ? { Prefer: 'IdType="ImmutableId", outlook.timezone="UTC"' }
            : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new AppError("CALENDAR_PROVIDER_UNAVAILABLE", 503);
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new AppError("REAUTH_REQUIRED", 401);
    }
    if (response.status === 403 || response.status === 404) {
      await response.body?.cancel();
      throw new AppError("CALENDAR_UNAVAILABLE", 403);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError("CALENDAR_PROVIDER_UNAVAILABLE", 503);
    }
    try {
      return await boundedJson(response, 500000);
    } catch {
      throw new AppError("CALENDAR_PROVIDER_UNAVAILABLE", 503);
    }
  }
  async resolveCalendar(accessToken: string, calendarId: string) {
    identifier.parse(calendarId);
    const url = new URL(
      this.provider === "google"
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`
        : calendarId === "primary"
          ? "https://graph.microsoft.com/v1.0/me/calendar"
          : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}`,
    );
    const body = await this.data(url, accessToken);
    if (this.provider === "google") {
      const result = providerPayload(
        z.object({ id: identifier, summary: z.string().max(1000).optional() }),
        body,
      );
      return {
        id: result.id,
        name: result.summary ?? "Google calendar",
        primary: calendarId === "primary",
      };
    }
    const result = providerPayload(
      z.object({
        id: identifier,
        name: z.string().max(1000),
        isDefaultCalendar: z.boolean().optional(),
      }),
      body,
    );
    return {
      id: result.id,
      name: result.name,
      primary: result.isDefaultCalendar ?? calendarId === "primary",
    };
  }
  async calendars(accessToken: string, cursor?: string) {
    let url: URL;
    if (this.provider === "google") {
      url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
      url.searchParams.set("maxResults", "100");
      if (cursor) url.searchParams.set("pageToken", z.string().max(16000).parse(cursor));
      const result = providerPayload(
        z.object({
          items: z
            .array(
              z.object({
                id: identifier,
                summary: z.string().max(1000),
                primary: z.boolean().optional(),
              }),
            )
            .max(100),
          nextPageToken: z.string().max(16000).optional(),
        }),
        await this.data(url, accessToken),
      );
      return {
        items: result.items.map((item) => ({
          id: item.id,
          name: item.summary,
          primary: item.primary ?? false,
        })),
        nextCursor: result.nextPageToken ?? null,
      };
    }
    url = cursor
      ? new URL(z.string().max(16000).parse(cursor))
      : new URL("https://graph.microsoft.com/v1.0/me/calendars?$top=100");
    if (
      url.origin !== "https://graph.microsoft.com" ||
      url.pathname.toLowerCase() !== "/v1.0/me/calendars" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new AppError("INVALID_CALENDAR_CURSOR", 400);
    const result = providerPayload(
      z.object({
        value: z
          .array(
            z.object({
              id: identifier,
              name: z.string().max(1000),
              isDefaultCalendar: z.boolean().optional(),
            }),
          )
          .max(100),
        "@odata.nextLink": z.string().max(16000).optional(),
      }),
      await this.data(url, accessToken),
    );
    return {
      items: result.value.map((item) => ({
        id: item.id,
        name: item.name,
        primary: item.isDefaultCalendar ?? false,
      })),
      nextCursor: result["@odata.nextLink"] ?? null,
    };
  }
}
