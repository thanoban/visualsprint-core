import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { HttpCalendarPush } from "../src/infrastructure/calendar-push-provider.js";
import { OAuthCalendarProvider } from "../src/infrastructure/oauth-calendar.js";
import { calendarPushRoutes } from "../src/http/calendar-push-routes.js";
import { CalendarPush, type PushAttempt } from "../src/application/calendar-push.js";
import { installErrorHandler } from "@visualsprint/platform";
const id = randomUUID(),
  input = {
    id,
    calendarId: "calendar@example.test",
    callback: "https://app.example.test/webhooks/v3/cells/test/calendars/google",
    proof: "a".repeat(43),
    expiresAt: new Date(Date.now() + 86400000),
  };
const calendar = new OAuthCalendarProvider(
  "google",
  "id",
  "secret",
  "https://app.example.test/oauth",
  async () => {
    throw new Error("UNEXPECTED_READ");
  },
);
test("Google watch uses one immutable intent, fixed origin/expiry and no blind retries on timeout", async () => {
  let calls = 0;
  const provider = new HttpCalendarPush("google", calendar, async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      "https://www.googleapis.com/calendar/v3/calendars/calendar%40example.test/events/watch",
    );
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.id, id);
    assert.equal(body.token, input.proof);
    assert.equal(body.expiration, String(input.expiresAt.getTime()));
    return Response.json({
      id,
      resourceId: "resource",
      expiration: String(input.expiresAt.getTime()),
    });
  });
  const result = await provider.create("private-access", input);
  assert.equal(result.state, "active");
  assert.equal(calls, 1);
  const unknown = new HttpCalendarPush("google", calendar, async () => {
    calls++;
    throw new Error("private upstream trace");
  });
  assert.deepEqual(await unknown.create("access", input), { state: "unknown" });
  assert.equal(calls, 2);
});
test("Graph renewal/uncertainty reconciliation uses only its confirmed subscription ID and read-only primary guard", async () => {
  const primary = new OAuthCalendarProvider(
    "microsoft",
    "id",
    "secret",
    "https://app.example.test/oauth",
    async () => Response.json({ id: "calendar", name: "Calendar", isDefaultCalendar: true }),
  );
  const calls: string[] = [];
  const provider = new HttpCalendarPush("microsoft", primary, async (url, init) => {
    calls.push(init?.method ?? "GET");
    assert.match(String(url), /^https:\/\/graph.microsoft.com\/v1.0\/subscriptions/);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      assert.equal(body.includeResourceData, false);
      assert.equal(body.resource, "/me/events");
      assert.equal(body.clientState, input.proof);
    }
    return Response.json({
      id: "confirmed",
      resource: "/me/events",
      expirationDateTime: input.expiresAt.toISOString(),
      clientState: input.proof,
    });
  });
  assert.equal(
    (await provider.create("access", { ...input, calendarId: "calendar" })).state,
    "active",
  );
  const attempt = { externalId: "confirmed", requestedExpiresAt: input.expiresAt } as PushAttempt;
  assert.equal((await provider.renew("access", attempt)).state, "active");
  assert.equal((await provider.lookup("access", attempt)).state, "active");
  assert.deepEqual(calls, ["POST", "PATCH", "GET"]);
  const missing = new HttpCalendarPush(
    "microsoft",
    primary,
    async () => new Response("", { status: 404 }),
  );
  assert.deepEqual(await missing.lookup("access", attempt), { state: "unknown" });
});
test("Graph handshake is bounded plaintext only, never grants subscription authority or accepts notification data", async () => {
  let notifications = 0;
  const app = Fastify();
  installErrorHandler(app);
  calendarPushRoutes(app, {
    async microsoft() {
      notifications++;
    },
    async google() {
      notifications++;
    },
  } as unknown as CalendarPush);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/internal/calendar/webhooks/microsoft?validationToken=hello%3Cscript%3E",
      headers: { "content-type": "application/json" },
      payload: "not-json",
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /^text\/plain/);
    assert.equal(response.body, "hello<script>");
    assert.equal(notifications, 0);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/internal/calendar/webhooks/microsoft?validationToken=" + "x".repeat(2049),
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});
