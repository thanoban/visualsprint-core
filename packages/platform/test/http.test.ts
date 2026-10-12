import test from "node:test";
import assert from "node:assert/strict";
import { boundedJson } from "../src/index.js";
test("response limit applies to streamed bytes before parsing and never trusts content length", async () => {
  assert.deepEqual(await boundedJson(Response.json({ safe: true })), { safe: true });
  await assert.rejects(
    boundedJson(new Response("x".repeat(100), { headers: { "content-length": "1" } }), 20),
    /RESPONSE_BODY_TOO_LARGE/,
  );
  await assert.rejects(boundedJson(new Response(null)), /EMPTY_RESPONSE_BODY/);
});
