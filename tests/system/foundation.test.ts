import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { databasePool, migrate, ServiceIdentity, WorkOSVerifier } from "@visualsprint/platform";
// Only composition tests import several service entry points. Runtime services never do.
import { AccountService } from "../../services/account/src/application/account.js";
import { PostgresAccount } from "../../services/account/src/infrastructure/store.js";
import { accountApp } from "../../services/account/src/http/app.js";
import { WorkspaceService } from "../../services/workspace/src/application/workspace.js";
import { PostgresWorkspace } from "../../services/workspace/src/infrastructure/store.js";
import { AccountMemberships } from "../../services/workspace/src/infrastructure/account-client.js";
import { workspaceApp } from "../../services/workspace/src/http/app.js";
import { gatewayApp } from "../../services/gateway/src/http/app.js";
import { authzApp } from "../../services/authz/src/app.js";
import { OpenFgaPolicy } from "../../services/authz/src/policy.js";
import { bootstrap } from "../../services/authz/src/bootstrap.js";
import { AuthzPolicy } from "../../services/workspace/src/infrastructure/policy-client.js";
import { browserMeetingFlow } from "./browser-flow.js";
import { CaptureService } from "../../services/ingest/src/application/capture-service.js";
import { PostgresCapture } from "../../services/ingest/src/infrastructure/store.js";
import { Authorities } from "../../services/ingest/src/infrastructure/authorities.js";
import { RecallSignatures } from "../../services/ingest/src/infrastructure/webhook-signature.js";
import { ingestApp } from "../../services/ingest/src/http/app.js";

test("gateway, separate Account/Workspace databases and signed services enforce the complete private meeting flow", async () => {
  const accountMigration = databasePool(
    "postgres://vs_account_migration:local-migration-only@127.0.0.1:55434/account",
    1,
  );
  const workspaceMigration = databasePool(
    "postgres://vs_workspace_migration:local-migration-only@127.0.0.1:55433/workspace",
    1,
  );
  const accountDb = databasePool(
    "postgres://vs_account_runtime:local-runtime-only@127.0.0.1:55434/account",
    2,
  );
  const workspaceDb = databasePool(
    "postgres://vs_workspace_runtime:local-runtime-only@127.0.0.1:55433/workspace",
    2,
  );
  await migrate(
    accountMigration,
    fileURLToPath(new URL("../../services/account/migrations", import.meta.url)),
  );
  await migrate(
    workspaceMigration,
    fileURLToPath(new URL("../../services/workspace/migrations", import.meta.url)),
  );
  const gatewayKey = await generateKeyPair("EdDSA");
  const ingestMigration = databasePool(
    "postgres://vs_ingest_migration:local-migration-only@127.0.0.1:55436/ingest",
    1,
  );
  const ingestDb = databasePool(
    "postgres://vs_ingest_runtime:local-runtime-only@127.0.0.1:55436/ingest",
    2,
  );
  await migrate(
    ingestMigration,
    fileURLToPath(new URL("../../services/ingest/migrations", import.meta.url)),
  );
  const ingestKey = await generateKeyPair("EdDSA");
  const ingestPublic = { ...(await exportJWK(ingestKey.publicKey)), kid: "ingest-test" };
  const workspaceKey = await generateKeyPair("EdDSA");
  const workosKey = await generateKeyPair("RS256");
  const gatewayPublic = { ...(await exportJWK(gatewayKey.publicKey)), kid: "gateway-test" };
  const workspacePublic = { ...(await exportJWK(workspaceKey.publicKey)), kid: "workspace-test" };
  const workos = new WorkOSVerifier(
    {
      clientId: "client_test",
      issuer: "https://identity.example.com",
      audience: "https://api.example.com",
    },
    createLocalJWKSet({
      keys: [{ ...(await exportJWK(workosKey.publicKey)), kid: "workos-test" }],
    }),
  );
  const account = accountApp(
    new AccountService(new PostgresAccount(accountDb), "dev-cell"),
    (token) => workos.verify(token),
    new ServiceIdentity("account", {
      gateway: [gatewayPublic],
      workspace: [workspacePublic],
      ingest: [ingestPublic],
    }),
  );
  const accountUrl = await account.listen({ host: "127.0.0.1", port: 0 });
  const identity = new ServiceIdentity("workspace", { gateway: [gatewayPublic] });
  const fga = await bootstrap(
    "http://127.0.0.1:4180",
    "local-openfga-only",
    `composition-${randomUUID()}`,
  );
  const authzIdentity = new ServiceIdentity("authz", { workspace: [workspacePublic] });
  const authz = authzApp(
    new OpenFgaPolicy("http://127.0.0.1:4180", "local-openfga-only", fga.storeId, fga.modelId),
    async (token) => (await authzIdentity.verify(token)).actor,
  );
  const authzUrl = await authz.listen({ host: "127.0.0.1", port: 0 });
  const workspace = workspaceApp(
    new WorkspaceService(
      new PostgresWorkspace(workspaceDb),
      new AccountMemberships(accountUrl, workspaceKey.privateKey, "workspace-test"),
      new AuthzPolicy(authzUrl, workspaceKey.privateKey, "workspace-test"),
    ),
    async (token) => (await identity.verify(token)).actor,
    async (token) =>
      (await new ServiceIdentity("workspace", { ingest: [ingestPublic] }).verify(token)).actor,
  );
  const workspaceUrl = await workspace.listen({ host: "127.0.0.1", port: 0 });
  const authorities = new Authorities(
    workspaceUrl,
    accountUrl,
    ingestKey.privateKey,
    "ingest-test",
  );
  const captureRepository = new PostgresCapture(ingestDb);
  const providerId = randomUUID();
  const captureService = new CaptureService(
    captureRepository,
    authorities,
    authorities,
    {
      async create() {
        return { kind: "accepted", providerId };
      },
      async findAttempt() {
        return { kind: "not_found" };
      },
      async inspect() {
        return { providerId, status: "in_call_recording", occurredAt: new Date().toISOString() };
      },
      async leave() {
        return "accepted";
      },
    },
    "https://capture.example/webhooks/v3/cells/dev-cell/recall",
  );
  const webhookKey = randomBytes(32);
  const ingestIdentity = new ServiceIdentity("ingest", { gateway: [gatewayPublic] });
  const ingest = ingestApp(
    captureService,
    async (token) => (await ingestIdentity.verify(token)).actor,
    new RecallSignatures([`whsec_${webhookKey.toString("base64")}`]),
  );
  const ingestUrl = await ingest.listen({ host: "127.0.0.1", port: 0 });
  const gateway = gatewayApp(
    {
      accountUrl,
      cells: { "dev-cell": { workspace: workspaceUrl, ingest: ingestUrl } },
      privateKey: gatewayKey.privateKey,
      keyId: "gateway-test",
    },
    (token) => workos.verify(token),
  );
  const token = (subject: string, session: string) =>
    new SignJWT({ client_id: "client_test", sid: session })
      .setProtectedHeader({ alg: "RS256", kid: "workos-test" })
      .setSubject(subject)
      .setIssuer("https://identity.example.com")
      .setAudience("https://api.example.com")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(workosKey.privateKey);
  const ownerToken = await token(`user_${randomUUID().replaceAll("-", "")}`, randomUUID());
  const memberToken = await token(`user_${randomUUID().replaceAll("-", "")}`, randomUUID());
  const ownerHeaders = { authorization: `Bearer ${ownerToken}`, "idempotency-key": randomUUID() };
  const memberHeaders = { authorization: `Bearer ${memberToken}` };
  const invoke = async (
    method: "GET" | "POST" | "DELETE",
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const response = await gateway.inject({
      method,
      url,
      headers,
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
            headers: { ...headers, "content-type": "application/json" },
          }),
    });
    return { status: response.statusCode, data: response.json() as Record<string, unknown> };
  };
  try {
    const direct = await account.inject({
      url: "/api/v3/me",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(direct.statusCode, 401);
    const member = await invoke("GET", "/api/v3/me", memberHeaders);
    assert.equal(member.status, 200);
    const created = await invoke("POST", "/api/v3/workspaces", ownerHeaders, {
      name: "Founder customer history",
    });
    assert.equal(created.status, 200);
    const workspaceId = String(created.data.id);
    const base = `/api/v3/workspaces/${workspaceId}`;
    const denied = await invoke("GET", `${base}/meetings`, memberHeaders);
    assert.equal(denied.status, 403);
    const grant = await invoke(
      "POST",
      `${base}/members`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { userId: member.data.userId, active: true, expectedVersion: 0 },
    );
    assert.equal(grant.status, 200);
    const project = await invoke(
      "POST",
      `${base}/projects`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { name: "Acme rollout" },
    );
    assert.equal(project.status, 201);
    const meeting = await invoke(
      "POST",
      `${base}/meetings`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { title: "Acme kickoff", joinUrl: "https://meet.google.com/abc-defg-hij" },
    );
    assert.equal(meeting.status, 201);
    const meetingUrl = `${base}/meetings/${meeting.data.id}`;
    const assigned = await invoke(
      "POST",
      `${meetingUrl}/assignments`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { projectId: project.data.id, confirmed: true, expectedVersion: 1 },
    );
    assert.equal(assigned.status, 200);
    assert.equal((await invoke("GET", meetingUrl, memberHeaders)).status, 404);
    const shared = await invoke(
      "POST",
      `${meetingUrl}/shares`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { userId: member.data.userId, expectedVersion: 2 },
    );
    assert.equal(shared.status, 200);
    assert.equal((await invoke("GET", meetingUrl, memberHeaders)).status, 200);
    const revoke = await invoke(
      "POST",
      `${base}/members`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { userId: member.data.userId, active: false, expectedVersion: 1 },
    );
    assert.equal(revoke.status, 200);
    assert.equal((await invoke("GET", meetingUrl, memberHeaders)).status, 403);
    const gatewayUrl = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const captureMeeting = await invoke(
      "POST",
      `${base}/meetings`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { title: "Live capture test", joinUrl: "https://meet.google.com/abc-defg-hij" },
    );
    assert.equal(captureMeeting.status, 201);
    const capture = await invoke(
      "POST",
      `${base}/captures`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { meetingId: captureMeeting.data.id, expectedMeetingVersion: 1, maxDurationSeconds: 120 },
    );
    assert.equal(capture.status, 202, JSON.stringify(capture.data));
    assert.equal(capture.data.ready, true);
    const automation = await invoke(
      "POST",
      `${base}/automation-grants`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { connectionId: randomUUID(), consent: true },
    );
    assert.equal(automation.status, 200, JSON.stringify(automation.data));
    assert.equal(automation.data.capability, "calendar_capture");
    assert.equal((await invoke("GET", `${base}/automation-grants`, ownerHeaders)).status, 200);
    await captureService.work(workspaceId, String(capture.data.id));
    const record = (await captureRepository.scoped(workspaceId, (tx) =>
      tx.load(String(capture.data.id)),
    ))!;
    const raw = JSON.stringify({
      event: "transcript.data",
      data: {
        bot: { id: providerId, metadata: { attempt_id: record.attemptId } },
        transcript: { id: randomUUID() },
        data: {
          words: [
            { text: "Approved", start_timestamp: { relative: 0 }, end_timestamp: { relative: 1 } },
          ],
          participant: { id: 1, name: "Founder" },
        },
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", webhookKey)
      .update(`composition_msg.${timestamp}.${raw}`)
      .digest("base64");
    const callback = await gateway.inject({
      method: "POST",
      url: "/webhooks/v3/cells/dev-cell/recall",
      payload: raw,
      headers: {
        "content-type": "application/json",
        "webhook-id": "composition_msg",
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
    });
    assert.equal(callback.statusCode, 204, callback.body);
    const evidence = await invoke(
      "GET",
      `${base}/captures/${capture.data.id}/transcript`,
      ownerHeaders,
    );
    assert.equal(evidence.status, 200);
    assert.equal((evidence.data.segments as { text: string }[])[0]?.text, "Approved");
    assert.equal(
      (await invoke("GET", `${base}/captures/${capture.data.id}/transcript`, memberHeaders)).status,
      403,
    );
    await browserMeetingFlow(
      gatewayUrl,
      ownerToken,
      workspaceId,
      String(meeting.data.id),
      String(project.data.id),
    );
    assert.equal((await invoke("POST", "/api/v3/logout", ownerHeaders)).status, 200);
    assert.equal((await invoke("GET", meetingUrl, ownerHeaders)).status, 401);
    assert.equal(
      (
        await invoke("GET", `${base}/meetings`, {
          "x-actor-id": String(member.data.userId),
          "x-workspace-id": workspaceId,
        })
      ).status,
      401,
    );
  } finally {
    await gateway.close();
    await ingest.close();
    await ingestDb.end();
    await ingestMigration.end();
    await workspace.close();
    await authz.close();
    await fetch(`http://127.0.0.1:4180/stores/${fga.storeId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer local-openfga-only" },
    });
    await account.close();
    await accountDb.end();
    await workspaceDb.end();
    await accountMigration.end();
    await workspaceMigration.end();
  }
});
