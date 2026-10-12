import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Api, errorMessage, ApiError } from "../src/api.js";

test("browser transport pins relative API paths and never follows credential redirects", async () => {
  let calls = 0;
  const api = new Api(
    async () => "test-token",
    async (_path, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      assert.deepEqual(init?.headers, { authorization: "Bearer test-token" });
      return Response.json({ ok: true });
    },
  );
  for (const path of [
    "https://evil.example/api/v3/me",
    "//evil.example/api/v3/me",
    "/api/v3/../../other",
    "/api/v3/me#fragment",
  ])
    await assert.rejects(api.request(path, z.unknown()), /INVALID_API_PATH/);
  assert.equal(calls, 0);
  assert.deepEqual(await api.request("/api/v3/me", z.object({ ok: z.boolean() })), { ok: true });
});
test("401 and service outages do not retry writes or initiate login loops", async () => {
  for (const status of [401, 409, 503]) {
    let calls = 0;
    const api = new Api(
      async () => "test-token",
      async () => {
        calls++;
        return new Response("private error", { status });
      },
    );
    await assert.rejects(
      api.request("/api/v3/workspaces", z.unknown(), {
        method: "POST",
        body: { name: "test" },
        key: "same-command",
      }),
      { status },
    );
    assert.equal(calls, 1);
  }
  assert.match(errorMessage(new ApiError("UNAVAILABLE", 503)), /session is still signed in/);
});
