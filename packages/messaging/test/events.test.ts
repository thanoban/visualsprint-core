import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ServiceBusReceivedMessage } from "@azure/service-bus";
import { AzureEvents, deliveryEvent, eventMessage, settleDelivery } from "../src/index.js";
const event = {
  eventId: randomUUID(),
  type: "meeting.created.v1" as const,
  schemaVersion: 1 as const,
  workspaceId: randomUUID(),
  aggregateId: randomUUID(),
  aggregateVersion: 1,
  occurredAt: new Date().toISOString(),
  traceId: "a".repeat(32),
  actorId: null,
  references: [],
};
test("broker encoding binds metadata and refuses content or tenant mismatch", () => {
  const message = eventMessage(event) as ServiceBusReceivedMessage;
  assert.deepEqual(deliveryEvent(message), event);
  assert.throws(() => eventMessage({ ...event, transcript: "private text" } as typeof event));
  assert.throws(() => deliveryEvent({ ...message, messageId: randomUUID() }));
  assert.throws(() =>
    deliveryEvent({
      ...message,
      applicationProperties: { workspaceId: randomUUID(), schemaVersion: 1 },
    }),
  );
});
test("commit precedes acknowledgement; failure abandons; invalid contract dead letters", async () => {
  const calls: string[] = [];
  const receiver = {
    async completeMessage() {
      calls.push("ack");
    },
    async abandonMessage() {
      calls.push("retry");
    },
    async deadLetterMessage() {
      calls.push("invalid");
    },
  };
  const message = eventMessage(event) as ServiceBusReceivedMessage;
  await settleDelivery(receiver, message, async () => {
    calls.push("commit");
  });
  assert.deepEqual(calls, ["commit", "ack"]);
  calls.length = 0;
  await settleDelivery(receiver, message, async () => {
    throw new Error("DB unavailable");
  });
  assert.deepEqual(calls, ["retry"]);
  calls.length = 0;
  await settleDelivery(receiver, { ...message, body: { transcript: "must not log" } }, async () => {
    calls.push("bad");
  });
  assert.deepEqual(calls, ["invalid"]);
});
test("acknowledgement uncertainty is propagated for inbox-protected redelivery", async () => {
  const receiver = {
    async completeMessage() {
      throw new Error("ACK_UNKNOWN");
    },
    async abandonMessage() {},
    async deadLetterMessage() {},
  };
  await assert.rejects(
    settleDelivery(receiver, eventMessage(event) as ServiceBusReceivedMessage, async () => {}),
    /ACK_UNKNOWN/,
  );
  assert.throws(() => new AzureEvents("https://attacker.example"));
});
