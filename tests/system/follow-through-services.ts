import { fileURLToPath } from "node:url";
import type { JWK } from "jose";
import { databasePool, migrate, ServiceIdentity } from "@visualsprint/platform";
import { IntelligenceService } from "../../services/intelligence/src/application/intelligence.js";
import { PostgresIntelligence } from "../../services/intelligence/src/infrastructure/store.js";
import { AuthorizedSources } from "../../services/intelligence/src/infrastructure/sources.js";
import { intelligenceApp } from "../../services/intelligence/src/http/app.js";
import { ReportingService } from "../../services/reporting/src/application/reporting.js";
import { PostgresExports } from "../../services/reporting/src/infrastructure/store.js";
import { HttpExportSources } from "../../services/reporting/src/infrastructure/source-client.js";
import { reportingApp } from "../../services/reporting/src/http/app.js";
import { WorkflowService } from "../../services/workflow/src/application/workflow.js";
import { PostgresWorkflow } from "../../services/workflow/src/infrastructure/store.js";
import {
  WorkspaceActions,
  IntegrationActions,
} from "../../services/workflow/src/infrastructure/clients.js";
import { workflowApp } from "../../services/workflow/src/http/app.js";
import { NotificationService } from "../../services/notification/src/application/notification.js";
import { PostgresNotifications } from "../../services/notification/src/infrastructure/store.js";
import {
  NotificationAuthority,
  DisabledEmail,
} from "../../services/notification/src/infrastructure/authorities.js";
import { notificationApp } from "../../services/notification/src/http/app.js";
export async function followThroughServices(input: {
  accountUrl: string;
  workspaceUrl: string;
  ingestUrl: string;
  integrationUrl: string;
  gatewayPublic: JWK;
  workspacePublic: JWK;
  integrationPublic:JWK;
  keys: Record<
    "intelligence" | "reporting" | "workflow" | "notification",
    { privateKey: CryptoKey }
  >;
}) {
  const pools: { end(): Promise<void> }[] = [];
  const dbs = {} as Record<
    "intelligence" | "reporting" | "workflow" | "notification",
    ReturnType<typeof databasePool>
  >;
  for (const [name, port] of [
    ["intelligence", 55438],
    ["reporting", 55439],
    ["workflow", 55440],
    ["notification", 55441],
  ] as const) {
    const migration = databasePool(
      `postgres://vs_${name}_migration:local-migration-only@127.0.0.1:${port}/${name}`,
      1,
    );
    const pool = databasePool(
      `postgres://vs_${name}_runtime:local-runtime-only@127.0.0.1:${port}/${name}`,
      3,
    );
    pools.push(migration, pool);
    dbs[name] = pool;
    await migrate(
      migration,
      fileURLToPath(new URL(`../../services/${name}/migrations`, import.meta.url)),
    );
  }
  const authenticate = (name: string) => async (token: string) =>
    (await new ServiceIdentity(name, { gateway: [input.gatewayPublic] }).verify(token)).actor;
  const cleanup = (name: string) => async (token: string) =>
    (await new ServiceIdentity(name, { workspace: [input.workspacePublic] }).verify(token)).actor;
  const intelligence = new IntelligenceService(
    new PostgresIntelligence(dbs.intelligence),
    new AuthorizedSources(
      { account: input.accountUrl, workspace: input.workspaceUrl, ingest: input.ingestUrl },
      input.keys.intelligence.privateKey,
      "intelligence-test",
    ),
    {
      async generate({ evidence }) {
        return {
          claims: evidence.slice(0, 1).map((row) => ({
            kind: "discussion",
            text: row.text,
            citation: {
              meetingId: row.meetingId,
              captureId: row.captureId,
              segmentId: row.segmentId,
              revision: row.revision,
            },
          })),
          unsupported: evidence.length === 0,
        };
      },
    },
  );
  const reporting = new ReportingService(
    new PostgresExports(dbs.reporting),
    new HttpExportSources(
      input.workspaceUrl,
      input.ingestUrl,
      input.keys.reporting.privateKey,
      "reporting-test",
    ),
  );
  const workflow = new WorkflowService(
    new PostgresWorkflow(dbs.workflow),
    new WorkspaceActions(input.workspaceUrl, input.keys.workflow.privateKey, "workflow-test"),
    new IntegrationActions(input.integrationUrl, input.keys.workflow.privateKey, "workflow-test"),
  );
  const notification = new NotificationService(
    new PostgresNotifications(dbs.notification),
    new NotificationAuthority(
      input.accountUrl,
      input.workspaceUrl,
      input.keys.notification.privateKey,
      "notification-test",
    ),
    new DisabledEmail(),
    "https://app.example.com",
  );
  const apps = {
    intelligence: intelligenceApp(
      intelligence,
      authenticate("intelligence"),
      cleanup("intelligence"),
    ),
    reporting: reportingApp(reporting, authenticate("reporting"), cleanup("reporting")),
    workflow: workflowApp(workflow, authenticate("workflow"), async token=>(await new ServiceIdentity("workflow",{integration:[input.integrationPublic]}).verify(token)).actor, cleanup("workflow")),
    notification: notificationApp(
      notification,
      authenticate("notification"),
      undefined,
      cleanup("notification"),
    ),
  };
  const urls = {
    intelligence: await apps.intelligence.listen({ host: "127.0.0.1", port: 0 }),
    reporting: await apps.reporting.listen({ host: "127.0.0.1", port: 0 }),
    workflow: await apps.workflow.listen({ host: "127.0.0.1", port: 0 }),
    notification: await apps.notification.listen({ host: "127.0.0.1", port: 0 }),
  };
  return {
    urls,
    intelligence,
    reporting,
    workflow,
    notification,
    async close() {
      for (const app of Object.values(apps)) await app.close();
      for (const pool of pools) await pool.end();
    },
  };
}
