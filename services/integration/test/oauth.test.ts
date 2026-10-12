import test from "node:test";
import assert from "node:assert/strict";
import { OAuthCalendarProvider } from "../src/infrastructure/oauth-calendar.js";
test("authorization uses fixed vendor origin, PKCE, exact callback and readonly offline scopes", () => {
  for (const provider of ["google", "microsoft"] as const) {
    const adapter = new OAuthCalendarProvider(
      provider,
      "client",
      "secret",
      "https://app.example/oauth/calendar",
    );
    const url = new URL(adapter.authorizationUrl("state", "challenge"));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.example/oauth/calendar");
    assert.equal(url.searchParams.get("scope")?.includes("Write"), false);
    assert.equal(url.searchParams.get("scope")?.includes("readwrite"), false);
    assert.equal(
      url.hostname,
      provider === "google" ? "accounts.google.com" : "login.microsoftonline.com",
    );
  }
});
test("exchange uses form POST without redirects; refresh rotation is preserved", async () => {
  let received: RequestInit | undefined;
  const adapter = new OAuthCalendarProvider(
    "microsoft",
    "client",
    "secret",
    "https://app.example/oauth/calendar",
    async (_url, init) => {
      received = init;
      return Response.json({
        access_token: "access",
        refresh_token: "rotated",
        expires_in: 3600,
        scope: "Calendars.Read",
        token_type: "Bearer",
      });
    },
  );
  const tokens = await adapter.exchange("code", "verifier");
  assert.equal(tokens.refreshToken, "rotated");
  assert.equal(received?.redirect, "error");
  assert.equal((received?.body as URLSearchParams).get("code_verifier"), "verifier");
  assert.equal((await adapter.refresh("old")).refreshToken, "rotated");
});
test("provider configuration failure is not confused with reauthentication or a network error", async () => {
  const configured = (error: string) =>
    new OAuthCalendarProvider(
      "google",
      "client",
      "secret",
      "https://app.example/oauth/calendar",
      async () => Response.json({ error }, { status: 400 }),
    );
  await assert.rejects(
    configured("invalid_client").exchange("code", "verifier"),
    /CALENDAR_CONFIGURATION/,
  );
  await assert.rejects(configured("invalid_grant").refresh("refresh"), /REAUTH_REQUIRED/);
});
test("Graph pagination refuses a credential-exfiltration next URL before any request", async () => {
  let called = false;
  const adapter = new OAuthCalendarProvider(
    "microsoft",
    "client",
    "secret",
    "https://app.example/oauth/calendar",
    async () => {
      called = true;
      return Response.json({ value: [] });
    },
  );
  await assert.rejects(
    adapter.calendars("access", "https://evil.example/v1.0/me/calendars"),
    /INVALID_CALENDAR_CURSOR/,
  );
  assert.equal(called, false);
});
test("malformed vendor calendar responses are upstream failures, not user validation errors", async () => {
  for (const provider of ["google", "microsoft"] as const) {
    const adapter = new OAuthCalendarProvider(
      provider,
      "client",
      "secret",
      "https://app.example/oauth/calendar",
      async () => Response.json({ invalid: "provider shape" }),
    );
    for (const work of [
      () => adapter.calendars("access"),
      () => adapter.resolveCalendar("access", "primary"),
    ]) {
      await assert.rejects(
        work(),
        (error: unknown) =>
          error instanceof Error &&
          "status" in error &&
          error.status === 503 &&
          error.message === "CALENDAR_PROVIDER_UNAVAILABLE",
      );
    }
  }
});
