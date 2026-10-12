import test from "node:test";
import assert from "node:assert/strict";
import { mayChangeMembership } from "../src/domain/membership.js";
test("members cannot grant access; sole owner cannot revoke their own membership", () => {
  assert.equal(mayChangeMembership("member", false, false), false);
  assert.equal(mayChangeMembership("owner", true, true), false);
  assert.equal(mayChangeMembership("owner", false, true), true);
});
