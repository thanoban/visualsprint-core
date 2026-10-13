import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "jose";
import { gatewayApp } from "../src/http/app.js";
async function fixture(transport: typeof fetch) {
  const key = await generateKeyPair("EdDSA");
  return gatewayApp({ accountUrl: "https://account.invalid", privateKey: key.privateKey,
    keyId: "fixture", cells: { test: { integration: "https://integration.invalid" } } },
    async () => { throw new Error("provider callback must not use user auth"); }, transport);
}
test("calendar callbacks preserve bounded provider proof/bytes without forwarding user credentials", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const app = await fixture(async (input, init) => {
    calls.push({ url: String(input), init }); return new Response(null, { status: 204 });
  });
  try {
    const response = await app.inject({ method: "POST", url: "/webhooks/v3/cells/test/calendars/google",
      headers: { "x-goog-channel-id": "channel", "x-goog-channel-token": "fixture-token", authorization: "Bearer user-secret" } });
    assert.equal(response.statusCode, 204);
    assert.equal(calls[0]?.url, "https://integration.invalid/internal/calendar/webhooks/google");
    assert.equal((calls[0]?.init?.headers as Record<string,string>).authorization, undefined);
    const body = '{"value":[{"clientState":"proof"}]}';
    await app.inject({ method: "POST", url: "/webhooks/v3/cells/test/calendars/microsoft",
      headers: { "content-type": "application/json" }, payload: body });
    assert.equal(Buffer.from(calls[1]?.init?.body as Uint8Array).toString(), body);
    const count = calls.length;
    assert.equal((await app.inject({ method: "POST", url: "/webhooks/v3/cells/test/calendars/microsoft",
      headers: { "content-type": "application/json" }, payload: JSON.stringify({ value: "x".repeat(24000) }) })).statusCode, 413);
    assert.equal(calls.length, count);
  } finally { await app.close(); }
});
test("Microsoft validation needs configured origin and exact upstream plaintext; rejects mismatches", async () => {
  const app = await fixture(async input => new Response(new URL(String(input)).searchParams.get("validationToken")));
  try {
    const response = await app.inject({ method: "POST", url: "/webhooks/v3/cells/test/calendars/microsoft?validationToken=hello%20world" });
    assert.equal(response.statusCode, 200); assert.equal(response.body, "hello world");
    assert.match(response.headers["content-type"]!, /text\/plain/);
    assert.equal((await app.inject({ method: "POST", url: "/webhooks/v3/cells/unknown/calendars/microsoft?validationToken=x" })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/webhooks/v3/cells/test/calendars/google?validationToken=x" })).statusCode, 400);
  } finally { await app.close(); }
  const bad = await fixture(async () => new Response("unexpected"));
  try { assert.equal((await bad.inject({ method: "POST", url: "/webhooks/v3/cells/test/calendars/microsoft?validationToken=x" })).statusCode, 503); }
  finally { await bad.close(); }
});
