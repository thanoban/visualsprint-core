import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AesTokenVault } from "../src/infrastructure/vault.js";
test("token encryption binds workspace, connection and purpose; no plaintext envelope", () => {
  const vault = new AesTokenVault("v1", { v1: randomBytes(32).toString("base64") });
  const payload = { refreshToken: "private-refresh-token" };
  const sealed = vault.seal(payload, "workspace:connection:tokens");
  assert.equal(sealed.includes(payload.refreshToken), false);
  assert.deepEqual(vault.open(sealed, "workspace:connection:tokens"), payload);
  assert.throws(() => vault.open(sealed, "other:connection:tokens"), /TOKEN_STORE_UNAVAILABLE/);
  assert.throws(() => vault.open(sealed, "workspace:connection:oauth"), /TOKEN_STORE_UNAVAILABLE/);
  const modified = JSON.parse(sealed);
  modified.tag = Buffer.alloc(16).toString("base64");
  assert.throws(
    () => vault.open(JSON.stringify(modified), "workspace:connection:tokens"),
    /TOKEN_STORE_UNAVAILABLE/,
  );
});
test("key rotation reads prior keys and fails closed when the required key is missing", () => {
  const old = randomBytes(32).toString("base64"),
    next = randomBytes(32).toString("base64");
  const sealed = new AesTokenVault("old", { old }).seal({ secret: true }, "context");
  assert.deepEqual(new AesTokenVault("next", { old, next }).open(sealed, "context"), {
    secret: true,
  });
  assert.throws(
    () => new AesTokenVault("next", { next }).open(sealed, "context"),
    /TOKEN_STORE_UNAVAILABLE/,
  );
  assert.throws(() => new AesTokenVault("broken", { broken: Buffer.alloc(16).toString("base64") }));
});
