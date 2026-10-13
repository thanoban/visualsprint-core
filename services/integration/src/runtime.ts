import { importJWK } from "jose";
import { z } from "zod";
import { assertRuntimeRole, databasePool } from "@visualsprint/platform";
import { CalendarService } from "./application/calendars.js";
import { PostgresCalendars } from "./infrastructure/store.js";
import { AccountCalendars } from "./infrastructure/account-client.js";
import { OAuthCalendarProvider } from "./infrastructure/oauth-calendar.js";
import { AesTokenVault } from "./infrastructure/vault.js";
import type { CalendarProviders } from "./application/ports.js";
import { WorkspaceCalendars } from "./infrastructure/workspace-client.js";
import { IngestCalendars } from "./infrastructure/ingest-client.js";
import { PostgresCalendarCaptureTasks } from "./infrastructure/capture-tasks.js";
import { CalendarCaptureOrchestrator } from "./application/calendar-captures.js";
import { ActionExecutions } from "./application/action-executions.js";
import { PostgresActionExecutions } from "./infrastructure/action-store.js";
import { HttpWorkflowApproval } from "./infrastructure/workflow-client.js";
import { HttpActionProvider } from "./infrastructure/action-provider.js";
import { CalendarPush } from "./application/calendar-push.js";
import { PostgresCalendarPush } from "./infrastructure/calendar-push-store.js";
import { HttpCalendarPush } from "./infrastructure/calendar-push-provider.js";
export async function runtime() {
  const config = z
    .object({
      INTEGRATION_DATABASE_URL: z.string().min(1),
      ACCOUNT_INTERNAL_URL: z.string().url(),
      WORKSPACE_INTERNAL_URL: z.string().url().optional(),
      INGEST_INTERNAL_URL: z.string().url().optional(),
      WORKFLOW_INTERNAL_URL: z.string().url().optional(),
      SERVICE_PRIVATE_JWK: z.string().min(1),
      SERVICE_KEY_ID: z.string().min(1),
      TOKEN_KEY_ID: z.string().min(1),
      TOKEN_KEYS: z.string().min(1),
      CALENDAR_REDIRECT_URI: z.string().url(),
      CALENDAR_PUSH_CALLBACK_BASE: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.string().url().optional(),
      ),
      GOOGLE_CALENDAR_CLIENT_ID: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.string().min(1).optional(),
      ),
      GOOGLE_CALENDAR_CLIENT_SECRET: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.string().min(1).optional(),
      ),
      MICROSOFT_CALENDAR_CLIENT_ID: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.string().min(1).optional(),
      ),
      MICROSOFT_CALENDAR_CLIENT_SECRET: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.string().min(1).optional(),
      ),
    })
    .parse(process.env);
  const key = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
  if (key instanceof Uint8Array) throw new Error("INVALID_SERVICE_KEY");
  const providers: CalendarProviders = {};
  const pushProviders: Partial<Record<"google" | "microsoft", HttpCalendarPush>> = {};
  for (const [provider, clientId, secret] of [
    ["google", config.GOOGLE_CALENDAR_CLIENT_ID, config.GOOGLE_CALENDAR_CLIENT_SECRET],
    ["microsoft", config.MICROSOFT_CALENDAR_CLIENT_ID, config.MICROSOFT_CALENDAR_CLIENT_SECRET],
  ] as const) {
    if (Boolean(clientId) !== Boolean(secret))
      throw new Error("INCOMPLETE_CALENDAR_OAUTH_CONFIGURATION");
    if (clientId && secret) {
      providers[provider] = new OAuthCalendarProvider(
        provider,
        clientId,
        secret,
        config.CALENDAR_REDIRECT_URI,
      );
      pushProviders[provider] = new HttpCalendarPush(
        provider,
        providers[provider] as OAuthCalendarProvider,
      );
    }
  }
  const vault = new AesTokenVault(
    config.TOKEN_KEY_ID,
    z.record(z.string(), z.string()).parse(JSON.parse(config.TOKEN_KEYS)),
  );
  const pool = databasePool(config.INTEGRATION_DATABASE_URL);
  await assertRuntimeRole(pool);
  const repository = new PostgresCalendars(pool);
  const push = new CalendarPush(
    new PostgresCalendarPush(pool),
    pushProviders,
    vault,
    config.CALENDAR_PUSH_CALLBACK_BASE,
  );
  const authority = new AccountCalendars(config.ACCOUNT_INTERNAL_URL, key, config.SERVICE_KEY_ID);
  const meetings = config.WORKSPACE_INTERNAL_URL
    ? new WorkspaceCalendars(config.WORKSPACE_INTERNAL_URL, key, config.SERVICE_KEY_ID)
    : undefined;
  if (config.INGEST_INTERNAL_URL && !meetings)
    throw new Error("CALENDAR_CAPTURE_REQUIRES_WORKSPACE");
  return {
    pool,
    repository,
    actions: config.WORKFLOW_INTERNAL_URL
      ? new ActionExecutions(
          new PostgresActionExecutions(pool),
          authority,
          new HttpWorkflowApproval(config.WORKFLOW_INTERNAL_URL, key, config.SERVICE_KEY_ID),
          vault,
          new HttpActionProvider(),
        )
      : undefined,
    async purge(workspaceId: string, deletionId: string, meetingId: string, sourceVersion: number) {
      await new PostgresCalendarCaptureTasks(pool).purge(
        workspaceId,
        deletionId,
        meetingId,
        sourceVersion,
      );
      const externalCleanup = await new PostgresActionExecutions(pool).remove(
        workspaceId,
        deletionId,
        meetingId,
        sourceVersion,
      );
      return {
        deletionId,
        meetingId,
        participant: "integration",
        state: "complete",
        externalCleanup,
      };
    },
    service: new CalendarService(
      repository,
      authority,
      providers,
      vault,
      () => new Date(),
      meetings,
      config.INGEST_INTERNAL_URL && meetings
        ? new CalendarCaptureOrchestrator(
            new PostgresCalendarCaptureTasks(pool),
            authority,
            meetings,
            new IngestCalendars(config.INGEST_INTERNAL_URL, key, config.SERVICE_KEY_ID),
          )
        : undefined,
      push,
    ),
    providers,
    push,
  };
}
