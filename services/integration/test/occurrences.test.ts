import test from "node:test";
import assert from "node:assert/strict";
import {
  googleOccurrence,
  microsoftOccurrence,
} from "../src/infrastructure/occurrence-normalization.js";
import { OAuthCalendarProvider } from "../src/infrastructure/oauth-calendar.js";
const timing = {
  start: { dateTime: "2026-10-12T10:00:00+05:30" },
  end: { dateTime: "2026-10-12T11:00:00+05:30" },
};
test("reused meeting links never merge distinct events; recurring reschedules retain original identity", () => {
  const event = {
    id: "a",
    ...timing,
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    recurringEventId: "series",
    originalStartTime: timing.start,
  };
  const first = googleOccurrence(event),
    moved = googleOccurrence({
      ...event,
      start: { dateTime: "2026-10-13T10:00:00+05:30" },
      end: { dateTime: "2026-10-13T11:00:00+05:30" },
    });
  assert.equal(first.sourceKey, moved.sourceKey);
  assert.notEqual(first.startsAt, moved.startsAt);
  assert.notEqual(
    googleOccurrence({ id: "a", ...timing }).sourceKey,
    googleOccurrence({ id: "b", ...timing }).sourceKey,
  );
  assert.equal(first.startsAt, "2026-10-12T04:30:00.000Z");
});
test("cancelled, declined and all-day events cannot become ordinary capturable calls", () => {
  assert.equal(googleOccurrence({ id: "cancel", status: "cancelled" }).joinUrl, null);
  assert.equal(
    googleOccurrence({ id: "day", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } })
      .startsAt,
    null,
  );
  assert.equal(
    googleOccurrence({
      id: "declined",
      ...timing,
      attendees: [{ self: true, responseStatus: "declined" }],
    }).declined,
    true,
  );
});
test("untrusted descriptions preserve Zoom passcodes but reject ambiguous or spoofed links", () => {
  assert.equal(
    googleOccurrence({
      id: "a",
      ...timing,
      description: '<a href="https://us02web.zoom.us/j/123456789?pwd=secret&amp;x=1">join</a>',
    }).joinUrl,
    "https://us02web.zoom.us/j/123456789?pwd=secret&x=1",
  );
  assert.equal(
    googleOccurrence({ id: "a", ...timing, description: "https://zoom.us.evil.example/j/123" })
      .joinUrl,
    null,
  );
  assert.equal(
    googleOccurrence({
      id: "a",
      ...timing,
      description: "https://meet.google.com/abc-defg-hij https://meet.google.com/xyz-abcd-efg",
    }).joinUrl,
    null,
  );
});
test("Graph UTC timestamps and immutable event IDs normalize without guessing other timezones", () => {
  const event = {
    id: "immutable",
    start: { dateTime: "2026-10-12T10:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-10-12T11:00:00", timeZone: "UTC" },
  };
  assert.equal(microsoftOccurrence(event).startsAt, "2026-10-12T10:00:00.000Z");
  assert.throws(
    () =>
      microsoftOccurrence({
        ...event,
        start: { ...event.start, timeZone: "Eastern Standard Time" },
      }),
    /UNSUPPORTED_CALENDAR_TIMEZONE/,
  );
});
test("Google expanded window paging never combines time bounds with incremental sync tokens", async () => {
  let received = new URL("https://unused.example");
  const provider = new OAuthCalendarProvider(
    "google",
    "client",
    "secret",
    "https://app.example/oauth/calendar",
    async (input) => {
      received = new URL(String(input));
      return Response.json({ items: [{ id: "a", ...timing }], nextPageToken: "next" });
    },
  );
  const page = await provider.occurrences("access", "calendar/id", {
    startsAt: "2026-10-12T00:00:00Z",
    endsAt: "2026-10-26T00:00:00Z",
  });
  assert.equal(page.items.length, 1);
  assert.equal(received.searchParams.get("singleEvents"), "true");
  assert.equal(received.searchParams.has("syncToken"), false);
});
test("Graph calendarView next pages cannot redirect credentials to another calendar or origin", async () => {
  let calls = 0;
  const provider = new OAuthCalendarProvider(
    "microsoft",
    "client",
    "secret",
    "https://app.example/oauth/calendar",
    async () => {
      calls++;
      return Response.json({ value: [] });
    },
  );
  await assert.rejects(
    provider.occurrences(
      "access",
      "selected",
      { startsAt: "2026-10-12T00:00:00Z", endsAt: "2026-10-26T00:00:00Z" },
      "https://graph.microsoft.com/v1.0/me/calendars/other/calendarView",
    ),
    /INVALID_CALENDAR_CURSOR/,
  );
  assert.equal(calls, 0);
});
