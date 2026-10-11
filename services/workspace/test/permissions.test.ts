import test from "node:test";
import assert from "node:assert/strict";
import { canReadMeeting, canManageMeeting } from "../src/domain/permissions.js";
test("project association and workspace administration confer no meeting access", () => {
  const meeting = {ownerId: "owner", readerIds: ["reader"], blocked: false};
  assert.equal(canReadMeeting("workspace-admin", meeting), false);
  assert.equal(canReadMeeting("project-owner", meeting), false);
  assert.equal(canReadMeeting("reader", meeting), true);
  assert.equal(canManageMeeting("reader", meeting), false);
  assert.equal(canReadMeeting("owner", {...meeting, blocked: true}), false);
});
