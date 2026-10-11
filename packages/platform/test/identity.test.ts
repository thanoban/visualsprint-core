import test from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { ServiceIdentity, serviceToken, WorkOSVerifier } from "../src/index.js";

const actor = {actorId: "eeaab51a-af4a-47bd-9ec1-6e4421ffb76b", workspaceId: "f6a0e47d-0c68-43f2-886e-49d0a3cbf2ec", sessionId: "session-test"};
test("service delegation binds caller, audience, key, expiry and actor tenant", async () => {
  const gateway = await generateKeyPair("EdDSA");
  const other = await generateKeyPair("EdDSA");
  const publicKey = {...await exportJWK(gateway.publicKey), kid: "gateway-key"};
  const otherKey = {...await exportJWK(other.publicKey), kid: "other-key"};
  const verifier = new ServiceIdentity("workspace", {gateway: [publicKey], integration: [otherKey]});
  const valid = await serviceToken({caller: "gateway", audience: "workspace", actor, keyId: "gateway-key", privateKey: gateway.privateKey});
  assert.deepEqual((await verifier.verify(valid)).actor, actor);
  const wrongAudience = await serviceToken({caller: "gateway", audience: "account", actor, keyId: "gateway-key", privateKey: gateway.privateKey});
  await assert.rejects(() => verifier.verify(wrongAudience), /UNAUTHENTICATED_SERVICE/);
  const forgedCaller = await serviceToken({caller: "gateway", audience: "workspace", actor, keyId: "other-key", privateKey: other.privateKey});
  await assert.rejects(() => verifier.verify(forgedCaller), /UNAUTHENTICATED_SERVICE/);
  const expired = await new SignJWT({actor}).setProtectedHeader({alg: "EdDSA", kid: "gateway-key"}).setIssuer("gateway").setSubject("gateway").setAudience("workspace").setJti("test").setIssuedAt(1).setExpirationTime(2).sign(gateway.privateKey);
  await assert.rejects(() => verifier.verify(expired), /UNAUTHENTICATED_SERVICE/);
});
test("WorkOS verifier rejects a valid signature for a different API or client", async () => {
  const keys = await generateKeyPair("RS256");
  const verifier = new WorkOSVerifier({clientId: "client_test", issuer: "https://identity.example.com", audience: "https://api.example.com"}, createLocalJWKSet({keys: [{...await exportJWK(keys.publicKey), kid: "workos-test"}]}));
  const token = (aud: string, clientId = "client_test") => new SignJWT({sid: "session_test", client_id: clientId}).setProtectedHeader({alg: "RS256", kid: "workos-test"})
    .setSubject("user_test").setIssuer("https://identity.example.com").setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
  assert.deepEqual(await verifier.verify(await token("https://api.example.com")), {subject: "user_test", sessionId: "session_test"});
  await assert.rejects(async () => verifier.verify(await token("https://evil.example.com")), /UNAUTHENTICATED/);
  await assert.rejects(async () => verifier.verify(await token("https://api.example.com", "client_other")), /UNAUTHENTICATED/);
});
