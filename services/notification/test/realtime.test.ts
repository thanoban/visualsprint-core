import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppError, type Actor } from "@visualsprint/platform";
import {
  AzureRealtime,
  DisabledRealtime,
  recipient,
} from "../src/infrastructure/azure-realtime.js";
import { configuredRealtime } from "../src/infrastructure/realtime-runtime.js";
import { realtimePublisher } from "../src/infrastructure/realtime-publisher.js";
import { NotificationService } from "../src/application/notification.js";
import type { Authority, Repository, RealtimePort } from "../src/application/ports.js";
import { DisabledEmail } from "../src/infrastructure/authorities.js";
import { notificationApp } from "../src/http/app.js";
import { eventEnvelope } from "@visualsprint/contracts";

const actor: Actor = { workspaceId: randomUUID(), actorId: randomUUID(), sessionId: randomUUID() };
const endpoint = "https://vs-private.webpubsub.azure.com";
const clientToken = "controlledheader.controlledpayload.controlledsignature";
const credential = {
  async getToken(scope: string | string[]) {
    assert.equal(scope, "https://webpubsub.azure.com/.default");
    return { token: "controlled-identity", expiresOnTimestamp: Date.now() + 60000 };
  },
};

test("native token negotiation pins destination and grants no client publish, join or group roles", async () => {
  let calls = 0;
  const realtime = new AzureRealtime(endpoint, credential, async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, endpoint);
    assert.equal(url.pathname, "/api/hubs/visualsprint_notifications/:generateToken");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      "api-version": "2024-01-01",
      userId: recipient(actor.workspaceId, actor.actorId),
      minutesToExpire: "2",
    });
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.body, undefined);
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      "Bearer controlled-identity",
    );
    assert.ok(init?.signal);
    // An untrusted provider URL is never forwarded, even if present in a valid response.
    return Response.json({ token: clientToken, url: "https://evil.example/steal" });
  });
  const start = Date.now();
  const result = await realtime.negotiate(actor.workspaceId, actor.actorId);
  const socket = new URL(result.url);
  assert.equal(socket.protocol, "wss:");
  assert.equal(socket.hostname, "vs-private.webpubsub.azure.com");
  assert.equal(socket.pathname, "/client/hubs/visualsprint_notifications");
  assert.deepEqual(Object.fromEntries(socket.searchParams), { access_token: clientToken });
  assert.ok(Date.parse(result.expiresAt) >= start + 120000);
  assert.equal(calls, 1);
  assert.notEqual(
    recipient(actor.workspaceId, actor.actorId),
    recipient(randomUUID(), actor.actorId),
  );
  assert.notEqual(
    recipient(actor.workspaceId, actor.actorId),
    recipient(actor.workspaceId, randomUUID()),
  );
});

test("native push is recipient-only and contains no meeting, notification, tenant or transcript metadata", async () => {
  const realtime = new AzureRealtime(endpoint, credential, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(
      url.pathname,
      `/api/hubs/visualsprint_notifications/users/${recipient(actor.workspaceId, actor.actorId)}/:send`,
    );
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      "api-version": "2024-01-01",
      messageTtlSeconds: "15",
    });
    assert.deepEqual(JSON.parse(String(init?.body)), { type: "notifications.invalidate.v1" });
    assert.equal(init?.redirect, "error");
    return new Response(null, { status: 202 });
  });
  await realtime.invalidate(actor.workspaceId, actor.actorId);
});

test("realtime configuration fails closed and disabled mode makes no identity/provider calls", async () => {
  assert.equal(
    configuredRealtime({ enabled: false, endpoint: "https://evil.example" }).configured,
    false,
  );
  await assert.rejects(new DisabledRealtime().negotiate(), /REALTIME_NOT_CONFIGURED/);
  assert.throws(() => configuredRealtime({ enabled: true }), /INCOMPLETE_REALTIME_CONFIGURATION/);
  for (const invalid of [
    "http://vs.webpubsub.azure.com",
    "https://evil.example",
    "https://vs.webpubsub.azure.com.evil.example",
    "https://user:secret@vs.webpubsub.azure.com",
    "https://vs.webpubsub.azure.com:444",
    "https://vs.webpubsub.azure.com/path",
    "https://vs.webpubsub.azure.com/?secret=x",
    "https://vs.webpubsub.azure.com/#x",
  ])
    assert.throws(() => new AzureRealtime(invalid, credential), /INVALID_REALTIME_ENDPOINT/);
  for (const response of [
    new Response(null, { status: 302 }),
    new Response(null, { status: 401 }),
    new Response(null, { status: 429 }),
    new Response(null, { status: 503 }),
    Response.json({ token: "not-a-token" }),
    Response.json({ token: "x".repeat(17000) }),
  ]) {
    let calls = 0;
    const rt = new AzureRealtime(endpoint, credential, async () => {
      calls++;
      return response;
    });
    await assert.rejects(rt.negotiate(actor.workspaceId, actor.actorId), /REALTIME_UNAVAILABLE/);
    assert.equal(calls, 1);
  }
  const rt = new AzureRealtime(
    endpoint,
    {
      async getToken() {
        throw new Error("secret must not leak");
      },
    },
    async () => {
      throw new Error("MUST_NOT_CALL_PROVIDER");
    },
  );
  await assert.rejects(
    rt.negotiate(actor.workspaceId, actor.actorId),
    /REALTIME_IDENTITY_UNAVAILABLE/,
  );
});

function service(
  realtime: RealtimePort,
  requireSession: Authority["requireSession"] = async () => {},
) {
  return new NotificationService(
    {} as Repository,
    { requireSession } as Authority,
    new DisabledEmail(),
    "https://app.example.test",
    realtime,
  );
}

test("negotiation requires current normal membership before and after issuance", async () => {
  let checks = 0,
    issues = 0;
  const rt: RealtimePort = {
    configured: true,
    async invalidate() {},
    async negotiate(ws, user) {
      assert.equal(ws, actor.workspaceId);
      assert.equal(user, actor.actorId);
      issues++;
      return { url: "wss://controlled.example", expiresAt: new Date().toISOString() };
    },
  };
  const revoked = service(rt, async () => {
    if (++checks === 2) throw new AppError("FORBIDDEN", 403);
  });
  await assert.rejects(revoked.negotiate(actor), /FORBIDDEN/);
  assert.equal(issues, 1);
  assert.equal(checks, 2);
  await assert.rejects(
    service(rt).negotiate({ ...actor, operationGrantId: randomUUID() }),
    /FORBIDDEN/,
  );
  assert.equal(issues, 1);
  await assert.rejects(
    service(rt, async () => {
      throw new AppError("FORBIDDEN", 403);
    }).negotiate(actor),
    /FORBIDDEN/,
  );
  assert.equal(issues, 1);
});

test("public negotiation rejects substituted recipients, cross-workspace actors and operation principals; responses are uncacheable", async () => {
  let calls = 0;
  const rt: RealtimePort = {
    configured: true,
    async invalidate() {},
    async negotiate() {
      calls++;
      return { url: "wss://controlled.example", expiresAt: new Date().toISOString() };
    },
  };
  const app = notificationApp(service(rt), async (token) =>
    token === "operation" ? { ...actor, operationGrantId: randomUUID() } : actor,
  );
  try {
    const path = `/api/v3/workspaces/${actor.workspaceId}/realtime/negotiate`;
    const headers = { authorization: "Bearer controlled" };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { userId: randomUUID(), roles: ["webpubsub.sendToGroup"] },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: path + "?group=foreign", headers })).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path.replace(actor.workspaceId, randomUUID()),
          headers,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: "Bearer operation" },
        })
      ).statusCode,
      403,
    );
    const result = await app.inject({ method: "POST", url: path, headers });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers.pragma, "no-cache");
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test("durable publisher propagates uncertain invalidation so outbox retry is possible; hint duplicates never repeat business work", async () => {
  const event = eventEnvelope.parse({
    eventId: randomUUID(),
    type: "notification.delivery.changed.v1",
    schemaVersion: 1,
    workspaceId: actor.workspaceId,
    actorId: actor.actorId,
    aggregateId: randomUUID(),
    aggregateVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: randomUUID().replaceAll("-", ""),
    references: [],
  });
  let sends = 0,
    publishes = 0;
  const rt: RealtimePort = {
    configured: true,
    async negotiate() {
      throw new Error("not used");
    },
    async invalidate(ws, user) {
      assert.equal(ws, actor.workspaceId);
      assert.equal(user, actor.actorId);
      if (++sends === 1) throw new AppError("REALTIME_UNAVAILABLE", 503);
    },
  };
  const publisher = realtimePublisher(
    {
      async publish(input) {
        assert.equal(input.eventId, event.eventId);
        publishes++;
      },
    },
    rt,
  );
  await assert.rejects(publisher.publish(event), /REALTIME_UNAVAILABLE/);
  await publisher.publish(event);
  assert.equal(publishes, 2);
  assert.equal(sends, 2);
  await realtimePublisher(
    {
      async publish() {
        publishes++;
      },
    },
    new DisabledRealtime(),
  ).publish(event);
  assert.equal(publishes, 3);
  assert.equal(sends, 2);
});
