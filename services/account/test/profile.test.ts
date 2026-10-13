import test from "node:test";
import assert from "node:assert/strict";
import { WorkOSProfiles } from "../src/infrastructure/workos-profile.js";
const subject = "user_VerifiedSubject1";
const profile = {
  object: "user",
  id: subject,
  email: "verified@example.test",
  email_verified: true,
  updated_at: "2026-10-13T00:00:00Z",
};
test("WorkOS profile uses pinned server-origin and exact verified subject with bounded no-redirect lookup", async () => {
  let calls = 0;
  const provider = new WorkOSProfiles("sk_controlled_only", async (input, init) => {
    calls++;
    assert.equal(String(input), `https://api.workos.com/user_management/users/${subject}`);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      "Bearer sk_controlled_only",
    );
    return Response.json(profile);
  });
  assert.deepEqual(await provider.lookup(subject), {
    subject,
    verifiedEmail: "verified@example.test",
    providerUpdatedAt: new Date(profile.updated_at),
  });
  await assert.rejects(provider.lookup("user_1/../../other"), /PROFILE_SUBJECT_INVALID/);
  assert.equal(calls, 1);
});
test("unverified/deleted WorkOS users never yield a destination and provider failures never reuse claimed or stale email", async () => {
  for (const [response, expected] of [
    [Response.json({ ...profile, email_verified: false }), null],
    [new Response("", { status: 404 }), null],
  ] as const) {
    const provider = new WorkOSProfiles("sk_controlled_only", async () => response);
    assert.equal((await provider.lookup(subject)).verifiedEmail, expected);
  }
  for (const response of [
    Response.json({ ...profile, id: "user_AnotherSubject" }),
    Response.json({ ...profile, email_verified: "true" }),
    Response.json({ ...profile, email: "evil@example.test\nBcc: victim@example.test" }),
    new Response("", { status: 302 }),
    new Response("", { status: 401 }),
    new Response("", { status: 429 }),
    Response.json({ ...profile, payload: "x".repeat(40000) }),
  ]) {
    const provider = new WorkOSProfiles("sk_controlled_only", async () => response);
    await assert.rejects(
      provider.lookup(subject),
      /PROFILE_RESPONSE_INVALID|PROFILE_CONFIGURATION|PROFILE_PROVIDER_UNAVAILABLE/,
    );
  }
});
