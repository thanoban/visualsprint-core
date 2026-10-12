import test from "node:test";
import assert from "node:assert/strict";
import { reservationFailure } from "../src/domain/usage.js";

test("concurrent and monthly capture budgets are independent admission barriers", () => {
  const usage = {
    maxConcurrent: 5,
    monthlySeconds: 360000,
    active: 4,
    reservedSeconds: 40000,
    consumedSeconds: 300000,
  };
  assert.equal(reservationFailure(usage, 14400), null);
  assert.equal(reservationFailure({ ...usage, active: 5 }, 1), "CONCURRENCY_LIMIT");
  assert.equal(reservationFailure({ ...usage, consumedSeconds: 320000 }, 1), "QUOTA_EXCEEDED");
  assert.throws(() => reservationFailure(usage, 14401), /INVALID_RESERVATION/);
});
