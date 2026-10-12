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
export async function runtime() {
  const config = z
    .object({
      INTEGRATION_DATABASE_URL: z.string().min(1),
      ACCOUNT_INTERNAL_URL: z.string().url(),
      WORKSPACE_INTERNAL_URL: z.string().url().optional(),
      SERVICE_PRIVATE_JWK: z.string().min(1),
      SERVICE_KEY_ID: z.string().min(1),
      TOKEN_KEY_ID: z.string().min(1),
      TOKEN_KEYS: z.string().min(1),
      CALENDAR_REDIRECT_URI: z.string().url(),
      GOOGLE_CALENDAR_CLIENT_ID: z.string().min(1).optional(),
      GOOGLE_CALENDAR_CLIENT_SECRET: z.string().min(1).optional(),
      MICROSOFT_CALENDAR_CLIENT_ID: z.string().min(1).optional(),
      MICROSOFT_CALENDAR_CLIENT_SECRET: z.string().min(1).optional(),
    })
    .parse(process.env);
  const key = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
  if (key instanceof Uint8Array) throw new Error("INVALID_SERVICE_KEY");
  const providers: CalendarProviders = {};
  for (const [provider, clientId, secret] of [
    ["google", config.GOOGLE_CALENDAR_CLIENT_ID, config.GOOGLE_CALENDAR_CLIENT_SECRET],
    ["microsoft", config.MICROSOFT_CALENDAR_CLIENT_ID, config.MICROSOFT_CALENDAR_CLIENT_SECRET],
  ] as const) {
    if (Boolean(clientId) !== Boolean(secret))
      throw new Error("INCOMPLETE_CALENDAR_OAUTH_CONFIGURATION");
    if (clientId && secret)
      providers[provider] = new OAuthCalendarProvider(
        provider,
        clientId,
        secret,
        config.CALENDAR_REDIRECT_URI,
      );
  }
  const vault = new AesTokenVault(
    config.TOKEN_KEY_ID,
    z.record(z.string(), z.string()).parse(JSON.parse(config.TOKEN_KEYS)),
  );
  const pool = databasePool(config.INTEGRATION_DATABASE_URL);
  await assertRuntimeRole(pool);
  const repository = new PostgresCalendars(pool);
  const authority = new AccountCalendars(config.ACCOUNT_INTERNAL_URL, key, config.SERVICE_KEY_ID);
  return {
    pool,
    repository,
    service: new CalendarService(
      repository,
      authority,
      providers,
      vault,
      () => new Date(),
      config.WORKSPACE_INTERNAL_URL
        ? new WorkspaceCalendars(config.WORKSPACE_INTERNAL_URL, key, config.SERVICE_KEY_ID)
        : undefined,
    ),
    providers,
  };
}
