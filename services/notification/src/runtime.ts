import { importJWK } from "jose";
import { z } from "zod";
import { databasePool, assertRuntimeRole } from "@visualsprint/platform";
import { PostgresNotifications } from "./infrastructure/store.js";
import { NotificationAuthority } from "./infrastructure/authorities.js";
import { configuredEmail } from "./infrastructure/email-runtime.js";
import { configuredRealtime } from "./infrastructure/realtime-runtime.js";
import { NotificationService } from "./application/notification.js";
export async function runtime() {
  const config = z
    .object({
      NOTIFICATION_DATABASE_URL: z.string().min(1),
      ACCOUNT_INTERNAL_URL: z.string().url(),
      WORKSPACE_INTERNAL_URL: z.string().url(),
      WEB_APP_ORIGIN: z.string().url(),
      AZURE_EMAIL_ENDPOINT: z.string().url().optional(),
      AZURE_EMAIL_SENDER: z.string().min(1).optional(),
      AZURE_CLIENT_ID: z.string().uuid().optional(),
      ALLOW_LOCAL_EMAIL_AZURE_CLI: z.enum(["true", "false"]).default("false"),
      NOTIFICATION_REALTIME_ENABLED: z.enum(["true", "false"]).default("false"),
      AZURE_WEB_PUBSUB_ENDPOINT: z.string().url().optional(),
      SERVICE_PRIVATE_JWK: z.string().min(1),
      SERVICE_KEY_ID: z.string().min(1),
    })
    .parse(process.env);
  const key = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
  if (key instanceof Uint8Array) throw new Error("INVALID_SERVICE_KEY");
  const pool = databasePool(config.NOTIFICATION_DATABASE_URL);
  await assertRuntimeRole(pool);
  const repository = new PostgresNotifications(pool);
  return {
    pool,
    repository,
    service: new NotificationService(
      repository,
      new NotificationAuthority(
        config.ACCOUNT_INTERNAL_URL,
        config.WORKSPACE_INTERNAL_URL,
        key,
        config.SERVICE_KEY_ID,
      ),
      configuredEmail({
        endpoint: config.AZURE_EMAIL_ENDPOINT,
        sender: config.AZURE_EMAIL_SENDER,
        webOrigin: config.WEB_APP_ORIGIN,
        identityClientId: config.AZURE_CLIENT_ID,
        allowLocalAzureCli: config.ALLOW_LOCAL_EMAIL_AZURE_CLI === "true",
      }),
      config.WEB_APP_ORIGIN,
      configuredRealtime({
        enabled: config.NOTIFICATION_REALTIME_ENABLED === "true",
        endpoint: config.AZURE_WEB_PUBSUB_ENDPOINT,
        identityClientId: config.AZURE_CLIENT_ID,
      }),
    ),
  };
}
