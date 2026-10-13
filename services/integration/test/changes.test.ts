import test from "node:test";
import assert from "node:assert/strict";
import { OAuthCalendarProvider } from "../src/infrastructure/oauth-calendar.js";
const window = { startsAt: "2026-10-14T00:00:00Z", endsAt: "2026-10-28T00:00:00Z" };
test("Google change feed requests only IDs, preserves query shape and uses durable page/sync tokens without forbidden time filters", async () => {
  const calls: URL[] = [];
  const provider = new OAuthCalendarProvider(
    "google",
    "id",
    "secret",
    "https://app.example.test/oauth",
    async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      return Response.json(
        calls.length === 1
          ? { items: [{ id: "changed", summary: "private" }], nextPageToken: "page" }
          : { items: [], nextSyncToken: "next" },
      );
    },
  );
  assert.deepEqual(await provider.changes("access", "calendar", window, "previous"), {
    changed: true,
    nextCursor: "page",
    finalCursor: null,
  });
  assert.deepEqual(await provider.changes("access", "calendar", window, "previous", "page"), {
    changed: false,
    nextCursor: null,
    finalCursor: "next",
  });
  for (const url of calls) {
    assert.equal(url.searchParams.get("singleEvents"), "false");
    assert.equal(url.searchParams.get("syncToken"), "previous");
    assert.equal(url.searchParams.has("timeMin"), false);
    assert.equal(url.searchParams.has("timeMax"), false);
    assert.equal(url.searchParams.get("fields"), "items(id),nextPageToken,nextSyncToken");
  }
  assert.equal(calls[1]!.searchParams.get("pageToken"), "page");
});
test("Graph primary delta pins opaque continuation URLs and does not use unsupported select/beta/nonprimary paths", async () => {
  const calls: string[] = [];
  const cursor = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=opaque";
  const provider = new OAuthCalendarProvider(
    "microsoft",
    "id",
    "secret",
    "https://app.example.test/oauth",
    async (input, init) => {
      calls.push(String(input));
      assert.match(
        String((init?.headers as Record<string, string>).Prefer),
        /odata.maxpagesize=100/,
      );
      return Response.json(
        calls.length === 1
          ? { id: "primary-id", name: "Calendar", isDefaultCalendar: true }
          : { value: [], "@odata.deltaLink": cursor },
      );
    },
  );
  assert.deepEqual(await provider.changes("access", "primary-id", window), {
    changed: false,
    nextCursor: null,
    finalCursor: cursor,
  });
  const initial = new URL(calls[1]!);
  assert.equal(initial.pathname, "/v1.0/me/calendarView/delta");
  assert.equal(initial.searchParams.has("$select"), false);
  await assert.rejects(
    provider.changes("access", "primary-id", window, "https://evil.example/steal"),
    /INVALID_CHANGE_CURSOR/,
  );
  const secondary = new OAuthCalendarProvider(
    "microsoft",
    "id",
    "secret",
    "https://app.example.test/oauth",
    async () => Response.json({ id: "secondary", name: "Other", isDefaultCalendar: false }),
  );
  await assert.rejects(
    secondary.changes("access", "secondary", window),
    /CALENDAR_INCREMENTAL_UNSUPPORTED/,
  );
});
test("expired/malformed/foreign change cursors fail closed rather than advancing synchronization", async () => {
  const expired = new OAuthCalendarProvider(
    "google",
    "id",
    "secret",
    "https://app.example.test/oauth",
    async () => new Response("", { status: 410 }),
  );
  await assert.rejects(
    expired.changes("access", "calendar", window, "expired"),
    /CALENDAR_SYNC_EXPIRED/,
  );
  const malformed = new OAuthCalendarProvider(
    "google",
    "id",
    "secret",
    "https://app.example.test/oauth",
    async () => Response.json({ items: [], nextPageToken: "page", nextSyncToken: "final" }),
  );
  await assert.rejects(malformed.changes("access", "calendar", window), /INVALID_CHANGE_CURSOR/);
  const graph = new OAuthCalendarProvider(
    "microsoft",
    "id",
    "secret",
    "https://app.example.test/oauth",
    async () =>
      Response.json({
        value: [],
        "@odata.nextLink": "https://graph.microsoft.com/beta/me/calendarView/delta?$skiptoken=bad",
      }),
  );
  await assert.rejects(
    graph.changes(
      "access",
      "primary",
      window,
      "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=old",
    ),
    /INVALID_CHANGE_CURSOR/,
  );
});
