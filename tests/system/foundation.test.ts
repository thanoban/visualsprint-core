import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  AppError,
  databasePool,
  migrate,
  ServiceIdentity,
  serviceToken,
  WorkOSVerifier,
} from "@visualsprint/platform";
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
import { CalendarService } from "../../services/integration/src/application/calendars.js";
import { PostgresCalendars } from "../../services/integration/src/infrastructure/store.js";
import { AccountCalendars } from "../../services/integration/src/infrastructure/account-client.js";
import { AesTokenVault } from "../../services/integration/src/infrastructure/vault.js";
import { integrationApp } from "../../services/integration/src/http/app.js";
import { WorkspaceCalendars } from "../../services/integration/src/infrastructure/workspace-client.js";
import { IngestCalendars } from "../../services/integration/src/infrastructure/ingest-client.js";
import { CalendarCaptureOrchestrator } from "../../services/integration/src/application/calendar-captures.js";
import { PostgresCalendarCaptureTasks } from "../../services/integration/src/infrastructure/capture-tasks.js";
import { followThroughServices } from "./follow-through-services.js";
import { PostgresDeletions } from "../../services/workspace/src/infrastructure/deletion-store.js";
import {
  DeletionService,
  type DeletionParticipant,
  type DeletionPort,
} from "../../services/workspace/src/application/deletion-service.js";
import { HttpDeletionParticipant } from "../../services/workspace/src/infrastructure/deletion-client.js";
import { PostgresAuthzDeletions } from "../../services/authz/src/deletion-store.js";
import { AuthzDeletionService } from "../../services/authz/src/deletion-service.js";
import { OpenFgaMeetingPurge } from "../../services/authz/src/deletion-provider.js";
import { authzDeletionRoutes } from "../../services/authz/src/deletion-routes.js";
import { ActionExecutions } from "../../services/integration/src/application/action-executions.js";
import { PostgresActionExecutions } from "../../services/integration/src/infrastructure/action-store.js";
import { HttpWorkflowApproval } from "../../services/integration/src/infrastructure/workflow-client.js";
import { actionRoutes } from "../../services/integration/src/http/action-routes.js";

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
  const readKeys = {
    intelligence: await generateKeyPair("EdDSA"),
    reporting: await generateKeyPair("EdDSA"),
    workflow: await generateKeyPair("EdDSA"),
    notification: await generateKeyPair("EdDSA"),
  };
  const readerPublic = {
    intelligence: [
      { ...(await exportJWK(readKeys.intelligence.publicKey)), kid: "intelligence-test" },
    ],
    reporting: [{ ...(await exportJWK(readKeys.reporting.publicKey)), kid: "reporting-test" }],
    workflow: [{ ...(await exportJWK(readKeys.workflow.publicKey)), kid: "workflow-test" }],
  };
  const integrationMigration = databasePool(
    "postgres://vs_integration_migration:local-migration-only@127.0.0.1:55437/integration",
    1,
  );
  const integrationDb = databasePool(
    "postgres://vs_integration_runtime:local-runtime-only@127.0.0.1:55437/integration",
    2,
  );
  await migrate(
    integrationMigration,
    fileURLToPath(new URL("../../services/integration/migrations", import.meta.url)),
  );
  const integrationKey = await generateKeyPair("EdDSA");
  const integrationPublic = {
    ...(await exportJWK(integrationKey.publicKey)),
    kid: "integration-test",
  };
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
      integration: [integrationPublic],
      ...readerPublic,
      notification: [
        { ...(await exportJWK(readKeys.notification.publicKey)), kid: "notification-test" },
      ],
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
  const authzMigration = databasePool(
    "postgres://vs_authz_app_migration:local-migration-only@127.0.0.1:55435/authz_application",
    1,
  );
  const authzDb = databasePool(
    "postgres://vs_authz_app_runtime:local-runtime-only@127.0.0.1:55435/authz_application",
    2,
  );
  await migrate(
    authzMigration,
    fileURLToPath(new URL("../../services/authz/migrations", import.meta.url)),
  );
  const authzDeletions = new PostgresAuthzDeletions(authzDb);
  const authz = authzApp(
    new OpenFgaPolicy(
      "http://127.0.0.1:4180",
      "local-openfga-only",
      fga.storeId,
      fga.modelId,
      authzDeletions,
    ),
    async (token) => (await authzIdentity.verify(token)).actor,
  );
  authzDeletionRoutes(
    authz,
    new AuthzDeletionService(
      authzDeletions,
      new OpenFgaMeetingPurge(
        "http://127.0.0.1:4180",
        "local-openfga-only",
        fga.storeId,
        fga.modelId,
      ),
    ),
    async (token) => (await authzIdentity.verify(token)).actor,
  );
  const authzUrl = await authz.listen({ host: "127.0.0.1", port: 0 });
  const workspaceService = new WorkspaceService(
    new PostgresWorkspace(workspaceDb),
    new AccountMemberships(accountUrl, workspaceKey.privateKey, "workspace-test"),
    new AuthzPolicy(authzUrl, workspaceKey.privateKey, "workspace-test"),
  );
  const deletionPorts: Partial<Record<DeletionParticipant, DeletionPort>> = {};
  deletionPorts.authz = new HttpDeletionParticipant(
    "authz",
    authzUrl,
    workspaceKey.privateKey,
    "workspace-test",
  );
  const deletionService = new DeletionService(
    new PostgresDeletions(workspaceDb),
    {
      active: (actor) =>
        new AccountMemberships(accountUrl, workspaceKey.privateKey, "workspace-test").requireActive(
          actor,
        ),
      manage: async (actor, meetingId) => {
        await workspaceService.manageContext(actor, meetingId);
      },
    },
    deletionPorts,
  );
  const workspace = workspaceApp(
    workspaceService,
    async (token) => (await identity.verify(token)).actor,
    async (token) =>
      (await new ServiceIdentity("workspace", { ingest: [ingestPublic] }).verify(token)).actor,
    async (token) =>
      (await new ServiceIdentity("workspace", { integration: [integrationPublic] }).verify(token))
        .actor,
    async (token) => (await new ServiceIdentity("workspace", readerPublic).verify(token)).actor,
    async (token) =>
      (
        await new ServiceIdentity("workspace", {
          gateway: [gatewayPublic],
          ...readerPublic,
        }).verify(token)
      ).actor,
    deletionService,
    async (token) =>
      (
        await new ServiceIdentity("workspace", {
          notification: [
            { ...(await exportJWK(readKeys.notification.publicKey)), kid: "notification-test" },
          ],
        }).verify(token)
      ).actor,
  );
  const workspaceUrl = await workspace.listen({ host: "127.0.0.1", port: 0 });
  const calendarIdentity = new ServiceIdentity("integration", { gateway: [gatewayPublic] });
  const integrationService = new CalendarService(
    new PostgresCalendars(integrationDb),
    new AccountCalendars(accountUrl, integrationKey.privateKey, "integration-test"),
    {
      google: {
        authorizationUrl: (state, challenge) =>
          `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}`,
        async exchange() {
          return {
            accessToken: "controlled-access",
            refreshToken: "controlled-refresh",
            expiresAt: new Date(Date.now() + 3600000),
          };
        },
        async refresh() {
          return {
            accessToken: "controlled-access",
            refreshToken: "controlled-refresh",
            expiresAt: new Date(Date.now() + 3600000),
          };
        },
        async calendars() {
          return {
            items: [{ id: "calendar-test", name: "Team calendar", primary: true }],
            nextCursor: null,
          };
        },
        async resolveCalendar() {
          return { id: "calendar-test", name: "Team calendar", primary: true };
        },
        async occurrences() {
          return {
            items: [
              {
                sourceKey: "founder-calendar-call",
                providerEventId: "event-1",
                title: "Calendar customer review",
                status: "confirmed" as const,
                startsAt: new Date().toISOString(),
                endsAt: new Date(Date.now() + 3600000).toISOString(),
                allDay: false,
                declined: false,
                joinUrl: "https://meet.google.com/abc-defg-hij",
              },
            ],
            nextCursor: null,
          };
        },
      },
    },
    new AesTokenVault("test", { test: randomBytes(32).toString("base64") }),
    () => new Date(),
    new WorkspaceCalendars(workspaceUrl, integrationKey.privateKey, "integration-test"),
  );
  const integration = integrationApp(
    integrationService,
    async (token) => (await calendarIdentity.verify(token)).actor,
    ["google"],
  );
  let follow: Awaited<ReturnType<typeof followThroughServices>>;
  const actionExecutions = new ActionExecutions(
    new PostgresActionExecutions(integrationDb),
    new AccountCalendars(accountUrl, integrationKey.privateKey, "integration-test"),
    {
      proof: (actor, operationId) =>
        new HttpWorkflowApproval(
          follow.urls.workflow,
          integrationKey.privateKey,
          "integration-test",
        ).proof(actor, operationId),
      reference: (actor, operationId) =>
        new HttpWorkflowApproval(
          follow.urls.workflow,
          integrationKey.privateKey,
          "integration-test",
        ).reference(actor, operationId),
    },
    new AesTokenVault("action-test", { "action-test": randomBytes(32).toString("base64") }),
    {
      async create() {
        return { state: "confirmed", externalId: "123" };
      },
      async verify() {
        return true;
      },
      async status() {
        return {
          externalId: "123",
          state: "open",
          status: "open",
          updatedAt: new Date().toISOString(),
        };
      },
    },
  );
  actionRoutes(
    integration,
    actionExecutions,
    async (token) => (await calendarIdentity.verify(token)).actor,
    async (token) =>
      (await new ServiceIdentity("integration", { workflow: readerPublic.workflow }).verify(token))
        .actor,
  );
  integration.post("/internal/workspaces/:workspaceId/deletions/:deletionId", async (request) => {
    const token = request.headers.authorization!.slice(7),
      actor = (
        await new ServiceIdentity("integration", { workspace: [workspacePublic] }).verify(token)
      ).actor;
    const params = request.params as { workspaceId: string; deletionId: string },
      input = request.body as { meetingId: string; sourceVersion: number };
    assert.equal(params.workspaceId, actor.workspaceId);
    await new PostgresCalendarCaptureTasks(integrationDb).purge(
      actor.workspaceId,
      params.deletionId,
      input.meetingId,
      input.sourceVersion,
    );
    return actionExecutions.delete(actor, params.deletionId, input);
  });
  const integrationUrl = await integration.listen({ host: "127.0.0.1", port: 0 });
  deletionPorts.integration = new HttpDeletionParticipant(
    "integration",
    integrationUrl,
    workspaceKey.privateKey,
    "workspace-test",
  );
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
    async (token) =>
      (await new ServiceIdentity("ingest", { integration: [integrationPublic] }).verify(token))
        .actor,
    async (token) =>
      (
        await new ServiceIdentity("ingest", {
          gateway: [gatewayPublic],
          intelligence: readerPublic.intelligence,
          reporting: readerPublic.reporting,
        }).verify(token)
      ).actor,
    async (token) =>
      (await new ServiceIdentity("ingest", { workspace: [workspacePublic] }).verify(token)).actor,
  );
  const ingestUrl = await ingest.listen({ host: "127.0.0.1", port: 0 });
  deletionPorts.ingest = new HttpDeletionParticipant(
    "ingest",
    ingestUrl,
    workspaceKey.privateKey,
    "workspace-test",
  );
  follow = await followThroughServices({
    accountUrl,
    workspaceUrl,
    ingestUrl,
    integrationUrl,
    gatewayPublic,
    workspacePublic,
    integrationPublic,
    keys: readKeys,
  });
  for (const name of ["intelligence", "reporting", "workflow", "notification"] as const)
    deletionPorts[name] = new HttpDeletionParticipant(
      name,
      follow.urls[name],
      workspaceKey.privateKey,
      "workspace-test",
    );
  const gateway = gatewayApp(
    {
      accountUrl,
      cells: {
        "dev-cell": {
          workspace: workspaceUrl,
          ingest: ingestUrl,
          integration: integrationUrl,
          ...follow.urls,
        },
      },
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
    const calendarStart = await invoke(
      "POST",
      `${base}/connections/calendar/oauth/start`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { provider: "google" },
    );
    assert.equal(calendarStart.status, 201, JSON.stringify(calendarStart.data));
    const calendarRecord = calendarStart.data.connection as { id: string };
    const state = new URL(String(calendarStart.data.authorizationUrl)).searchParams.get("state")!;
    const calendarFinish = await invoke(
      "POST",
      `${base}/connections/calendar/oauth/finish`,
      ownerHeaders,
      { connectionId: calendarRecord.id, state, code: "controlled-code" },
    );
    assert.equal(calendarFinish.status, 202);
    assert.equal(
      (
        await invoke(
          "POST",
          `${base}/connections/calendar/${calendarRecord.id}/initialize`,
          ownerHeaders,
        )
      ).status,
      200,
    );
    const calendars = await invoke(
      "GET",
      `${base}/connections/calendar/${calendarRecord.id}/calendars`,
      ownerHeaders,
    );
    assert.equal(calendars.status, 200);
    assert.equal((calendars.data.items as { name: string }[])[0]?.name, "Team calendar");
    const occurrences = await invoke(
      "GET",
      `${base}/connections/calendar/${calendarRecord.id}/occurrences`,
      ownerHeaders,
    );
    assert.equal(occurrences.status, 200);
    assert.equal((occurrences.data.items as unknown[]).length, 1);
    assert.equal(occurrences.data.nextCursor, null);
    const sync = await invoke("POST", `${base}/connections/calendar/${calendarRecord.id}/sync`, {
      ...ownerHeaders,
      "idempotency-key": randomUUID(),
    });
    assert.equal(sync.status, 202);
    assert.equal(sync.data.state, "queued");
    // Use the same service application object as the native independent worker.
    await integrationService.work(workspaceId, calendarRecord.id);
    const syncStatus = await invoke(
      "GET",
      `${base}/connections/calendar/${calendarRecord.id}/sync`,
      ownerHeaders,
    );
    assert.equal(syncStatus.data.state, "complete");
    const saved = await invoke(
      "GET",
      `${base}/connections/calendar/${calendarRecord.id}/stored-occurrences`,
      ownerHeaders,
    );
    const savedEvent = (saved.data.items as { id: string; version: number }[])[0]!;
    const imported = await invoke(
      "POST",
      `${base}/connections/calendar/${calendarRecord.id}/meetings`,
      ownerHeaders,
      { occurrenceId: savedEvent.id, expectedVersion: savedEvent.version },
    );
    assert.equal(imported.status, 200, JSON.stringify(imported.data));
    const importedCapture = await invoke(
      "POST",
      `${base}/captures`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      {
        meetingId: imported.data.id,
        expectedMeetingVersion: imported.data.version,
        maxDurationSeconds: 120,
      },
    );
    assert.equal(importedCapture.status, 202, JSON.stringify(importedCapture.data));
    assert.equal(importedCapture.data.ready, true);
    assert.equal(
      (
        await invoke(
          "POST",
          `${base}/connections/calendar/${calendarRecord.id}/meetings`,
          { ...ownerHeaders, "idempotency-key": randomUUID() },
          {
            occurrenceId: savedEvent.id,
            expectedVersion: savedEvent.version,
            title: "Injected title",
          },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await invoke(
          "POST",
          `${base}/connections/calendar/${calendarRecord.id}/meetings`,
          ownerHeaders,
          { occurrenceId: savedEvent.id, expectedVersion: savedEvent.version },
        )
      ).data.id,
      imported.data.id,
    );
    assert.equal(
      (
        await invoke(
          "GET",
          `${base}/connections/calendar/${calendarRecord.id}/stored-occurrences`,
          ownerHeaders,
        )
      ).status,
      200,
    );
    const denied = await invoke("GET", `${base}/meetings`, memberHeaders);
    assert.equal(denied.status, 403);
    const grant = await invoke(
      "POST",
      `${base}/members`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { userId: member.data.userId, active: true, expectedVersion: 0 },
    );
    assert.equal(grant.status, 200);
    assert.equal(
      (await invoke("GET", `${base}/meetings/${imported.data.id}`, memberHeaders)).status,
      404,
    );
    assert.equal(
      (
        await invoke(
          "GET",
          `${base}/connections/calendar/${calendarRecord.id}/calendars`,
          memberHeaders,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await invoke(
          "GET",
          `${base}/connections/calendar/${calendarRecord.id}/occurrences`,
          memberHeaders,
        )
      ).status,
      404,
    );
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
    // Controlled final source enables genuine cross-service retrieval; it is not live meeting-end proof.
    await captureRepository.scoped(workspaceId, (tx) =>
      tx.update(String(capture.data.id), {
        state: "partial",
        providerDone: true,
        departedAt: new Date(),
        transcriptHealth: "ended",
        coverage: "known_gaps",
      }),
    );
    const summary = await invoke(
      "POST",
      `${base}/intelligence/summaries`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { meetingId: captureMeeting.data.id },
    );
    assert.equal(summary.status, 202, JSON.stringify(summary.data));
    await follow.intelligence.work(workspaceId, String(summary.data.id));
    const summaryResult = await invoke(
      "GET",
      `${base}/intelligence/jobs/${summary.data.id}`,
      ownerHeaders,
    );
    assert.equal(summaryResult.data.status, "complete", JSON.stringify(summaryResult.data));
    assert.equal(
      (summaryResult.data.result as { claims: { text: string }[]; partial: boolean }).claims[0]!
        .text,
      "Approved",
    );
    assert.equal((summaryResult.data.result as { partial: boolean }).partial, true);
    const thread = await invoke(
      "POST",
      `${base}/intelligence/chats`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { title: "Customer history", scope: { kind: "project", id: project.data.id } },
    );
    assert.equal(thread.status, 201, JSON.stringify(thread.data));
    const answer = await invoke(
      "POST",
      `${base}/intelligence/chats/${thread.data.id}/messages`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { text: "What was approved?" },
    );
    assert.equal(answer.status, 202);
    await follow.intelligence.work(workspaceId, String(answer.data.id));
    assert.equal(
      (await invoke("GET", `${base}/intelligence/chats/${thread.data.id}/messages`, ownerHeaders))
        .status,
      200,
    );
    const exportJob = await invoke(
      "POST",
      `${base}/exports`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { meetingId: captureMeeting.data.id, format: "json" },
    );
    assert.equal(exportJob.status, 202, JSON.stringify(exportJob.data));
    await follow.reporting.work(workspaceId, String(exportJob.data.id));
    const download = await invoke(
      "GET",
      `${base}/exports/${exportJob.data.id}/download`,
      ownerHeaders,
    );
    assert.equal(download.status, 200, JSON.stringify(download.data));
    assert.ok(JSON.stringify(download.data).includes("Approved"));
    const connector = await invoke(
      "POST",
      `${base}/action-connections`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { provider: "github", repository: "founder/demo", credential: "controlled-pat" },
    );
    assert.equal(connector.status, 201, JSON.stringify(connector.data));
    const action = await invoke(
      "POST",
      `${base}/actions`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      {
        connectionId: connector.data.id,
        provider: "github",
        destination: "founder/demo",
        payload: { title: "Reviewed follow-up", description: "Approved", dueDate: null },
        source: { meetingId: captureMeeting.data.id, revision: 1 },
      },
    );
    assert.equal(action.status, 201, JSON.stringify(action.data));
    const approvedAction = await invoke(
      "POST",
      `${base}/actions/${action.data.id}/approve`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { expectedVersion: action.data.version, confirmed: true },
    );
    assert.equal(approvedAction.status, 200);
    const operation = await invoke(
      "POST",
      `${base}/actions/${action.data.id}/execute`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { expectedVersion: approvedAction.data.version },
    );
    assert.equal(operation.status, 202, JSON.stringify(operation.data));
    await follow.workflow.work(workspaceId, String(operation.data.id));
    const executed = await invoke("GET", `${base}/operations/${operation.data.id}`, ownerHeaders);
    assert.equal(executed.data.state, "confirmed", JSON.stringify(executed.data));
    assert.equal(
      (
        await invoke(
          "GET",
          `${base}/action-executions/${operation.data.id}/task-status`,
          ownerHeaders,
        )
      ).status,
      200,
    );
    // Reader signing keys can read authorized evidence but cannot create Workspace records.
    const ownerContextForRead = await invoke("GET", "/api/v3/me", ownerHeaders);
    const readerProof = await serviceToken({
      caller: "reporting",
      audience: "workspace",
      actor: {
        actorId: String(ownerContextForRead.data.userId),
        workspaceId,
        sessionId: (await workos.verify(ownerToken)).sessionId,
      },
      privateKey: readKeys.reporting.privateKey,
      keyId: "reporting-test",
    });
    assert.equal(
      (
        await workspace.inject({
          method: "POST",
          url: `${base}/meetings`,
          headers: { authorization: `Bearer ${readerProof}`, "idempotency-key": randomUUID() },
          payload: { title: "Reader cannot write" },
        })
      ).statusCode,
      401,
    );
    const deletion = await invoke(
      "POST",
      `${base}/deletions`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { meetingId: captureMeeting.data.id, expectedVersion: 1 },
    );
    assert.equal(deletion.status, 202, JSON.stringify(deletion.data));
    assert.equal(
      (await invoke("GET", `${base}/meetings/${captureMeeting.data.id}`, ownerHeaders)).status,
      404,
    );
    await deletionService.work(workspaceId, String(deletion.data.id));
    const deletionStatus = await invoke(
      "GET",
      `${base}/deletions/${deletion.data.id}`,
      ownerHeaders,
    );
    assert.equal(deletionStatus.data.state, "pending");
    assert.deepEqual((deletionStatus.data.completed as string[]).sort(), [
      "authz",
      "integration",
      "intelligence",
      "notification",
      "reporting",
      "workflow",
    ]);
    assert.equal(
      (await invoke("GET", `${base}/exports/${exportJob.data.id}/download`, ownerHeaders)).status,
      404,
    );
    await captureService.work(workspaceId, String(capture.data.id));
    await deletionService.work(workspaceId, String(deletion.data.id));
    const completedDeletion = await invoke(
      "GET",
      `${base}/deletions/${deletion.data.id}`,
      ownerHeaders,
    );
    assert.equal(completedDeletion.data.state, "complete", JSON.stringify(completedDeletion.data));
    assert.equal((completedDeletion.data.completed as string[]).length, 7);
    const autoStart = await invoke(
      "POST",
      `${base}/connections/calendar/oauth/start`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { provider: "google" },
    );
    const autoConnection = (autoStart.data.connection as { id: string }).id;
    const autoState = new URL(String(autoStart.data.authorizationUrl)).searchParams.get("state")!;
    await invoke("POST", `${base}/connections/calendar/oauth/finish`, ownerHeaders, {
      connectionId: autoConnection,
      state: autoState,
      code: "auto-code",
    });
    const initialized = await invoke(
      "POST",
      `${base}/connections/calendar/${autoConnection}/initialize`,
      ownerHeaders,
    );
    const autoGrant = await invoke(
      "POST",
      `${base}/automation-grants`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      { connectionId: autoConnection, consent: true },
    );
    const activated = await invoke(
      "POST",
      `${base}/connections/calendar/${autoConnection}/automation`,
      { ...ownerHeaders, "idempotency-key": randomUUID() },
      {
        enabled: true,
        grantId: autoGrant.data.id,
        consent: true,
        expectedVersion: initialized.data.version,
      },
    );
    assert.equal(activated.status, 200, JSON.stringify(activated.data));
    assert.equal(activated.data.automatic, true);
    const ownerContext = await invoke("GET", "/api/v3/me", ownerHeaders);
    const principal = {
      actorId: String(member.data.userId),
      workspaceId,
      sessionId: `operation:${autoGrant.data.id}`,
      operationGrantId: String(autoGrant.data.id),
    };
    // Delegating a different owner cannot turn an active grant into authority.
    await assert.rejects(
      new WorkspaceCalendars(workspaceUrl, integrationKey.privateKey, "integration-test").upsert(
        principal,
        {
          connectionId: autoConnection,
          occurrenceId: randomUUID(),
          sourceVersion: 1,
          title: "Wrong actor",
          joinUrl: null,
          status: "confirmed",
          allDay: false,
          declined: false,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 60000).toISOString(),
        },
      ),
      /FORBIDDEN/,
    );
    assert.equal((await invoke("POST", "/api/v3/logout", ownerHeaders)).status, 200);
    const approved = { ...principal, actorId: String(ownerContext.data.userId) };
    const backgroundMeeting = await new WorkspaceCalendars(
      workspaceUrl,
      integrationKey.privateKey,
      "integration-test",
    ).upsert(approved, {
      connectionId: autoConnection,
      occurrenceId: randomUUID(),
      sourceVersion: 1,
      title: "Approved background meeting",
      joinUrl: "https://meet.google.com/abc-defg-hij",
      status: "confirmed",
      allDay: false,
      declined: false,
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal(
      (await authorities.capture(approved, backgroundMeeting.id)).meetingId,
      backgroundMeeting.id,
    );
    const proof = await serviceToken({
      caller: "integration",
      audience: "ingest",
      actor: approved,
      privateKey: integrationKey.privateKey,
      keyId: "integration-test",
    });
    const scheduled = await ingest.inject({
      method: "POST",
      url: `/internal/workspaces/${workspaceId}/calendar-captures`,
      headers: {
        authorization: `Bearer ${proof}`,
        "idempotency-key": `calendar:${principal.operationGrantId}:${randomUUID()}`,
      },
      payload: {
        meetingId: backgroundMeeting.id,
        expectedMeetingVersion: backgroundMeeting.version,
        maxDurationSeconds: 120,
        startsAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    assert.equal(scheduled.statusCode, 202, scheduled.body);
    const scheduledId = String(scheduled.json().id);
    const scheduledRecord = (await captureRepository.scoped(workspaceId, (tx) =>
      tx.load(scheduledId),
    ))!;
    assert.equal(scheduledRecord.quotaState, "pending");
    assert.equal(scheduledRecord.operationGrantId, approved.operationGrantId);
    const ordinaryActor = { actorId: approved.actorId, workspaceId, sessionId: "normal-session" };
    const ordinaryProof = await serviceToken({
      caller: "integration",
      audience: "ingest",
      actor: ordinaryActor,
      privateKey: integrationKey.privateKey,
      keyId: "integration-test",
    });
    assert.equal(
      (
        await ingest.inject({
          method: "POST",
          url: `/internal/workspaces/${workspaceId}/calendar-captures`,
          headers: { authorization: `Bearer ${ordinaryProof}`, "idempotency-key": randomUUID() },
          payload: {},
        })
      ).statusCode,
      403,
    );
    await assert.rejects(
      authorities.capture(approved, String(meeting.data.id)),
      (error) => error instanceof AppError && error.status === 403,
    );
    await integrationService.work(workspaceId, autoConnection);
    const persisted = await new PostgresCalendars(integrationDb).scoped(workspaceId, (tx) =>
      tx.latestSync(autoConnection),
    );
    assert.equal(persisted?.state, "complete");
    assert.equal(persisted?.operationGrantId, autoGrant.data.id);
    const autoRecord = (await new PostgresCalendars(integrationDb).scoped(workspaceId, (tx) =>
      tx.get(autoConnection),
    ))!;
    await new CalendarCaptureOrchestrator(
      new PostgresCalendarCaptureTasks(integrationDb),
      new AccountCalendars(accountUrl, integrationKey.privateKey, "integration-test"),
      new WorkspaceCalendars(workspaceUrl, integrationKey.privateKey, "integration-test"),
      new IngestCalendars(ingestUrl, integrationKey.privateKey, "integration-test"),
    ).work(autoRecord);
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
    await follow.close();
    await gateway.close();
    await integration.close();
    await integrationDb.end();
    await integrationMigration.end();
    await ingest.close();
    await ingestDb.end();
    await ingestMigration.end();
    await workspace.close();
    await authz.close();
    await authzDb.end();
    await authzMigration.end();
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
