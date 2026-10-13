import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AzureCommunicationEmail } from "../src/infrastructure/azure-email.js";
const endpoint = "https://vs-mail.communication.azure.com";
const workspaceId = randomUUID();
const input = {
  deliveryId: randomUUID(),
  to: "verified@example.test",
  subject: "Your VisualSprint update is ready",
  text: `An update is ready in your VisualSprint workspace. Open https://app.example.test/w/${workspaceId}`,
};
const credential = {
  async getToken(scopes: string | string[]) {
    assert.equal(scopes, "https://communication.azure.com//.default");
    return { token: "controlled-managed-identity", expiresOnTimestamp: Date.now() + 60000 };
  },
};
test("Azure send uses stable client operation identity, managed-identity bearer and plain generic text with no auto retry", async () => {
  let calls = 0;
  const adapter = new AzureCommunicationEmail(
    endpoint,
    "no-reply@verified.example",
    credential,
    "https://app.example.test",
    async (url, init) => {
      calls++;
      assert.equal(String(url), `${endpoint}/emails:send?api-version=2025-09-01`);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string>)["Operation-Id"], input.deliveryId);
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        "Bearer controlled-managed-identity",
      );
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        senderAddress: "no-reply@verified.example",
        content: { subject: input.subject, plainText: input.text },
        recipients: { to: [{ address: input.to }] },
        userEngagementTrackingDisabled: true,
      });
      return Response.json(
        { id: input.deliveryId, status: "Running" },
        {
          status: 202,
          headers: {
            "Operation-Location": `${endpoint}/emails/operations/${input.deliveryId}?api-version=2025-09-01`,
          },
        },
      );
    },
  );
  assert.deepEqual(await adapter.send(input), { state: "unknown" });
  assert.equal(calls, 1);
});
test("Azure lookup confirms only matching succeeded operation; missing, delayed, malformed and mismatched results are not absence proof", async () => {
  for (const [response, expected] of [
    [
      Response.json({ id: input.deliveryId, status: "Succeeded" }),
      { state: "sent", externalId: input.deliveryId },
    ],
    [Response.json({ id: input.deliveryId, status: "Running" }), { state: "pending" }],
    [new Response("", { status: 404 }), { state: "pending" }],
    [Response.json({ id: randomUUID(), status: "Succeeded" }), { state: "pending" }],
    [
      Response.json({ id: input.deliveryId, status: "Failed" }),
      { state: "rejected", code: "EMAIL_SEND_FAILED" },
    ],
  ] as const) {
    const adapter = new AzureCommunicationEmail(
      endpoint,
      "no-reply@verified.example",
      credential,
      "https://app.example.test",
      async (url, init) => {
        assert.equal(
          String(url),
          `${endpoint}/emails/operations/${input.deliveryId}?api-version=2025-09-01`,
        );
        assert.equal(init?.method, "GET");
        return response;
      },
    );
    assert.deepEqual(await adapter.lookup(input.deliveryId), expected);
  }
});
test("email template and endpoints reject foreign destinations, raw evidence and operation-location injection", async () => {
  for (const url of [
    "https://evil.example",
    "https://user:secret@vs-mail.communication.azure.com",
    "https://vs-mail.communication.azure.com/?x=1",
    "http://vs-mail.communication.azure.com",
  ])
    assert.throws(
      () =>
        new AzureCommunicationEmail(
          url,
          "no-reply@verified.example",
          credential,
          "https://app.example.test",
        ),
    );
  let calls = 0;
  const adapter = new AzureCommunicationEmail(
    endpoint,
    "no-reply@verified.example",
    credential,
    "https://app.example.test",
    async () => {
      calls++;
      return Response.json(
        { id: input.deliveryId, status: "Succeeded" },
        { status: 202, headers: { "Operation-Location": "https://evil.example/steal" } },
      );
    },
  );
  for (const changed of [
    { ...input, subject: "Private meeting title" },
    { ...input, text: "Raw transcript" },
    { ...input, text: input.text.replace("app.example.test", "evil.example") },
    { ...input, to: "recipient@example.test\nBcc: other@example.test" },
  ])
    await assert.rejects(adapter.send(changed));
  assert.equal(calls, 0);
  assert.deepEqual(await adapter.send(input), { state: "unknown" });
  assert.equal(calls, 1);
});
test("token/send response failures stay conservative and never trigger a second POST", async () => {
  for (const response of [
    new Response("", { status: 409 }),
    new Response("", { status: 500 }),
    new Response("", { status: 429 }),
    new Response("", { status: 302 }),
    Response.json({ id: input.deliveryId, status: "Unexpected" }, { status: 202 }),
  ]) {
    let calls = 0;
    const adapter = new AzureCommunicationEmail(
      endpoint,
      "no-reply@verified.example",
      credential,
      "https://app.example.test",
      async () => {
        calls++;
        return response;
      },
    );
    assert.deepEqual(await adapter.send(input), { state: "unknown" });
    assert.equal(calls, 1);
  }
  const adapter = new AzureCommunicationEmail(
    endpoint,
    "no-reply@verified.example",
    {
      async getToken() {
        throw new Error("identity unavailable");
      },
    },
    "https://app.example.test",
    async () => {
      throw new Error("must not send");
    },
  );
  await assert.rejects(adapter.send(input), /EMAIL_IDENTITY_UNAVAILABLE/);
});
