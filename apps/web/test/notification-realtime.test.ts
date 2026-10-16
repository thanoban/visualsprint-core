import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isNotificationHint,
  startNotificationRealtime,
  validateRealtimeLink,
} from "../src/notification-realtime.js";
const token = (payload: unknown = { sub: "opaque" }) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
const link = () => ({
  url: `wss://fixture.webpubsub.azure.com/client/hubs/visualsprint_notifications?access_token=${token()}`,
  expiresAt: new Date(Date.now() + 120000).toISOString(),
});
test("negotiated link is short-lived role-free and strictly pinned to Azure client hub", () => {
  assert.equal(validateRealtimeLink(link()).url, link().url);
  for (const url of [
    "ws://fixture.webpubsub.azure.com/client/hubs/visualsprint_notifications",
    "wss://fixture.webpubsub.azure.com.evil.test/client/hubs/visualsprint_notifications",
    "wss://user:pass@fixture.webpubsub.azure.com/client/hubs/visualsprint_notifications",
    link().url + "&group=all",
    link().url + "&access_token=duplicate",
    link().url.replace("visualsprint_notifications", "another_hub"),
  ])
    assert.throws(() => validateRealtimeLink({ ...link(), url }));
  assert.throws(() =>
    validateRealtimeLink({ ...link(), expiresAt: new Date(Date.now() + 300000).toISOString() }),
  );
  assert.throws(() =>
    validateRealtimeLink({
      ...link(),
      url: link().url.replace(token(), token({ roles: ["webpubsub.sendToGroup"] })),
    }),
  );
});
test("only exact content-free invalidation messages can trigger authorized reload", () => {
  assert.equal(isNotificationHint('{"type":"notifications.invalidate.v1"}'), true);
  for (const message of [
    "bad",
    '{"type":"notifications.invalidate.v1","meetingId":"private"}',
    '{"type":"other"}',
    new ArrayBuffer(8),
    " ".repeat(129),
  ])
    assert.equal(isNotificationHint(message), false);
});
test("documented singular permission/group JWT claims and aliases cannot grant socket privileges", () => {
  for (const claim of ["role", "roles", "groups", "wps.groups", "webpubsub.group"]) {
    for (const value of ["webpubsub.sendToGroup.private", ["private"], null, {}]) {
      assert.throws(() =>
        validateRealtimeLink({
          ...link(),
          url: link().url.replace(token(), token({ [claim]: value })),
        }),
      );
    }
  }
  assert.doesNotThrow(() =>
    validateRealtimeLink({
      ...link(),
      url: link().url.replace(token(), token({ role: [], "webpubsub.group": [] })),
    }),
  );
});
test("invalidation is coalesced, cleanup closes socket and late hints cannot refetch", async () => {
  let hints = 0,
    closes = 0;
  const socket = {
    close() {
      closes++;
    },
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null,
    onclose: null,
  };
  const stop = startNotificationRealtime({
    negotiate: async () => link(),
    open: () => socket as unknown as WebSocket,
    onHint: () => hints++,
    onStatus() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.onopen?.();
  socket.onmessage?.({ data: '{"type":"notifications.invalidate.v1"}' });
  socket.onmessage?.({ data: '{"type":"notifications.invalidate.v1"}' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(hints, 1);
  const oldHandler = socket.onmessage;
  stop();
  assert.equal(closes, 1);
  oldHandler?.({ data: '{"type":"notifications.invalidate.v1"}' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(hints, 1);
});
test("disabled negotiation does not retry or create a socket; disposal aborts pending negotiation", async () => {
  let negotiations = 0,
    opens = 0,
    aborted = false;
  const statuses: string[] = [];
  const stop = startNotificationRealtime({
    negotiate: async () => {
      negotiations++;
      throw new Error("REALTIME_NOT_CONFIGURED");
    },
    open: () => {
      opens++;
      throw new Error();
    },
    onHint() {},
    onStatus: (value) => statuses.push(value),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(negotiations, 1);
  assert.equal(opens, 0);
  assert.equal(statuses.at(-1), "fallback");
  stop();
  const dispose = startNotificationRealtime({
    negotiate: async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    },
    onHint() {},
    onStatus() {},
  });
  dispose();
  assert.equal(aborted, true);
});
