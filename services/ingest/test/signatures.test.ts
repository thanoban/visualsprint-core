import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { RecallSignatures } from "../src/infrastructure/webhook-signature.js";

const key = randomBytes(32);
const old = randomBytes(32);
const secret = `whsec_${key.toString("base64")}`;
const payload = Buffer.from('{"event":"transcript.data","text":"Customer context."}');
const timestamp = "1791774000";
function signed(prefix = "webhook", signingKey = key) {
  const digest = createHmac("sha256", signingKey)
    .update(Buffer.concat([Buffer.from(`msg_test.${timestamp}.`), payload]))
    .digest("base64");
  return {
    [`${prefix}-id`]: "msg_test",
    [`${prefix}-timestamp`]: timestamp,
    [`${prefix}-signature`]: `v1,${digest}`,
  };
}
test("Recall signatures authenticate exact raw bytes before parsing", () => {
  const verifier = new RecallSignatures([secret]);
  assert.equal(verifier.verify(signed(), payload, Number(timestamp)), "msg_test");
  assert.throws(
    () =>
      verifier.verify(
        signed(),
        Buffer.from(payload.toString().replace("Customer", "Attacker")),
        Number(timestamp),
      ),
    /INVALID_WEBHOOK_SIGNATURE/,
  );
  assert.throws(() =>
    verifier.verify(signed(), Buffer.concat([payload, Buffer.from(" ")]), Number(timestamp)),
  );
});
test("timestamps, duplicate headers and oversized unsigned requests fail closed", () => {
  const verifier = new RecallSignatures([secret]);
  for (const now of [Number(timestamp) + 301, Number(timestamp) - 301, Infinity])
    assert.throws(() => verifier.verify(signed(), payload, now));
  assert.throws(() =>
    verifier.verify(
      { ...signed(), "webhook-id": ["msg_test", "other"] },
      payload,
      Number(timestamp),
    ),
  );
  assert.throws(() =>
    verifier.verify({ ...signed(), "webhook-timestamp": "not-a-date" }, payload, Number(timestamp)),
  );
  assert.throws(() => verifier.verify(signed(), Buffer.alloc(1_000_001), Number(timestamp)));
});
test("key rotation accepts current or previous key but not unknown keys", () => {
  const verifier = new RecallSignatures([secret, `whsec_${old.toString("base64")}`]);
  assert.equal(verifier.verify(signed("webhook", old), payload, Number(timestamp)), "msg_test");
  assert.throws(() =>
    verifier.verify(signed("webhook", randomBytes(32)), payload, Number(timestamp)),
  );
  assert.throws(() => new RecallSignatures(["whsec_short"]));
});
test("legacy Svix secrets require explicit configuration and cannot substitute for workspace headers", () => {
  assert.throws(() =>
    new RecallSignatures([secret]).verify(signed("svix"), payload, Number(timestamp)),
  );
  assert.equal(
    new RecallSignatures([secret], "svix").verify(signed("svix"), payload, Number(timestamp)),
    "msg_test",
  );
  assert.throws(() =>
    new RecallSignatures([secret]).verify(
      { ...signed(), "webhook-signature": "v1,invalid", ...signed("svix") },
      payload,
      Number(timestamp),
    ),
  );
});
