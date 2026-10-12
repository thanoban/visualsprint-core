import test from "node:test";
import assert from "node:assert/strict";
import {
  saveCalendarFlow,
  calendarFlow,
  calendarReturn,
  removeCalendarFlow,
} from "../src/calendar-oauth.js";
const workspaceId = "11111111-1111-4111-8111-111111111111",
  connectionId = "22222222-2222-4222-8222-222222222222",
  nonce = "a".repeat(43);
test("OAuth browser state stores only routing context, rejects other origins and expires", () => {
  const rows = new Map<string, string>();
  const storage = {
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
    getItem: (key: string) => rows.get(key) ?? null,
    removeItem: (key: string) => {
      rows.delete(key);
    },
  };
  saveCalendarFlow(
    storage,
    workspaceId,
    connectionId,
    `https://accounts.google.com/o/oauth2/v2/auth?state=${nonce}`,
    100,
  );
  assert.deepEqual(calendarFlow(storage, nonce, 200), {
    workspaceId,
    connectionId,
    createdAt: 100,
  });
  assert.throws(() => calendarFlow(storage, nonce, 600101));
  assert.throws(() =>
    saveCalendarFlow(storage, workspaceId, connectionId, `https://evil.example/?state=${nonce}`),
  );
  const returned = calendarReturn(
    `https://app.example/oauth/calendar?code=private-one-time-code&state=${nonce}`,
  );
  assert.equal(returned.code, "private-one-time-code");
  assert.equal(
    [...rows.values()].some((value) => value.includes(returned.code)),
    false,
  );
  removeCalendarFlow(storage, nonce);
  assert.throws(() => calendarFlow(storage, nonce, 200));
});
