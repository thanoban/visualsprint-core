import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { calendarMeeting } from "../src/index.js";
test("calendar meeting contract rejects access assignment and invalid source intervals", () => {
  const input = {
    connectionId: randomUUID(),
    occurrenceId: randomUUID(),
    sourceVersion: 1,
    title: "Founder call",
    joinUrl: null,
    status: "confirmed",
    allDay: false,
    declined: false,
    startsAt: "2026-10-12T10:00:00Z",
    endsAt: "2026-10-12T11:00:00Z",
  };
  assert.equal(calendarMeeting.safeParse(input).success, true);
  assert.equal(calendarMeeting.safeParse({ ...input, projectId: randomUUID() }).success, false);
  assert.equal(calendarMeeting.safeParse({ ...input, ownerId: randomUUID() }).success, false);
  assert.equal(calendarMeeting.safeParse({ ...input, sourceVersion: 0 }).success, false);
  assert.equal(calendarMeeting.safeParse({ ...input, endsAt: input.startsAt }).success, false);
  assert.equal(
    calendarMeeting.safeParse({ ...input, status: "cancelled", startsAt: null, endsAt: null })
      .success,
    true,
  );
});
