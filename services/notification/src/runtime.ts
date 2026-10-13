import { importJWK } from "jose";
import { z } from "zod";
import { databasePool, assertRuntimeRole } from "@visualsprint/platform";
import { PostgresNotifications } from "./infrastructure/store.js";
import { NotificationAuthority, DisabledEmail } from "./infrastructure/authorities.js";
import { NotificationService } from "./application/notification.js";
export async function runtime() {
  const config = z
    .object({
      NOTIFICATION_DATABASE_URL: z.string().min(1),
      ACCOUNT_INTERNAL_URL: z.string().url(),
      WORKSPACE_INTERNAL_URL: z.string().url(),
      WEB_APP_ORIGIN: z.string().url(),
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
      new DisabledEmail(),
      config.WEB_APP_ORIGIN,
    ),
  };
}
