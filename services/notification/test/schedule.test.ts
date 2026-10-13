import test from "node:test";
import assert from "node:assert/strict";
import { nextDelivery } from "../src/domain/notification.js";
test("notification UTC schedule advances across day/month boundaries without changing the source clock", () => {
  const now = new Date("2026-10-31T22:15:00Z");
  assert.equal(nextDelivery(now, null).toISOString(), now.toISOString());
  assert.equal(nextDelivery(now, 23).toISOString(), "2026-10-31T23:00:00.000Z");
  assert.equal(nextDelivery(now, 4).toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(now.toISOString(), "2026-10-31T22:15:00.000Z");
  assert.throws(() => nextDelivery(now, 24));
});
