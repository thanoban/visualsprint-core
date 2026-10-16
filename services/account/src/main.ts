import { z } from "zod";
import {
  assertRuntimeRole,
  databasePool,
  ServiceIdentity,
  WorkOSVerifier,
  AppError,
} from "@visualsprint/platform";
import { AccountService } from "./application/account.js";
import { PostgresAccount } from "./infrastructure/store.js";
import { accountApp } from "./http/app.js";
import { configuredProfiles } from "./infrastructure/profile-runtime.js";
import { ModelUsageService } from "./application/model-usage.js";
import { PostgresModelUsage } from "./infrastructure/model-usage-store.js";
import { importJWK } from "jose";
import { CaptureConsentService } from "./application/capture-consent.js";
import { PostgresCaptureConsents } from "./infrastructure/capture-consent-store.js";
import { IngestCaptureOwnerContext } from "./infrastructure/capture-owner-context.js";
import {
  CaptureModelUsageService,
  type CaptureModelReadiness,
} from "./application/capture-model-usage.js";
import { PostgresCaptureModelUsage } from "./infrastructure/capture-model-store.js";
import { IngestCaptureModelReadiness } from "./infrastructure/capture-model-readiness.js";
const config = z
  .object({
    ACCOUNT_DATABASE_URL: z.string().min(1),
    DEFAULT_CELL_ID: z.string().min(1),
    WORKOS_CLIENT_ID: z.string().min(1),
    WORKOS_TOKEN_ISSUER: z.string().url(),
    WORKOS_TOKEN_AUDIENCE: z.string().min(1),
    WORKOS_PROFILE_API_KEY: z.string().min(1).optional(),
    SERVICE_TRUSTED_JWKS: z.string().min(1),
    CAPTURE_PROCESSING_ENABLED: z.enum(["true", "false"]).default("false"),
    CAPTURE_MODEL_ADMISSION_ENABLED: z.enum(["true", "false"]).default("false"),
    INGEST_INTERNAL_URL: z.string().url().optional(),
    SERVICE_PRIVATE_JWK: z.string().min(1).optional(),
    SERVICE_KEY_ID: z.string().min(1).optional(),
    PORT: z.coerce.number().int().positive().max(65535).default(4101),
  })
  .parse(process.env);
const pool = databasePool(config.ACCOUNT_DATABASE_URL);
await assertRuntimeRole(pool);
const workos = new WorkOSVerifier({
  clientId: config.WORKOS_CLIENT_ID,
  issuer: config.WORKOS_TOKEN_ISSUER,
  audience: config.WORKOS_TOKEN_AUDIENCE,
});
let captureConsents = new CaptureConsentService(new PostgresCaptureConsents(pool), {
  async read() {
    throw new AppError("CAPTURE_PROCESSING_NOT_CONFIGURED", 503);
  },
});
let captureReadiness: CaptureModelReadiness = {
  async assertReady() {
    throw new AppError("CAPTURE_MODEL_ADMISSION_NOT_CONFIGURED", 503);
  },
};
if (
  config.CAPTURE_MODEL_ADMISSION_ENABLED === "true" &&
  config.CAPTURE_PROCESSING_ENABLED === "true"
) {
  if (!config.INGEST_INTERNAL_URL || !config.SERVICE_PRIVATE_JWK || !config.SERVICE_KEY_ID)
    throw new Error("CAPTURE_MODEL_CONFIGURATION_INCOMPLETE");
  const key = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
  if (key instanceof Uint8Array) throw new Error("INVALID_SERVICE_SIGNING_KEY");
  captureReadiness = new IngestCaptureModelReadiness(
    config.INGEST_INTERNAL_URL,
    key,
    config.SERVICE_KEY_ID,
  );
}
if (config.CAPTURE_PROCESSING_ENABLED === "true") {
  if (!config.INGEST_INTERNAL_URL || !config.SERVICE_PRIVATE_JWK || !config.SERVICE_KEY_ID)
    throw new Error("CAPTURE_PROCESSING_CONFIGURATION_INCOMPLETE");
  const key = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
  if (key instanceof Uint8Array) throw new Error("INVALID_SERVICE_SIGNING_KEY");
  captureConsents = new CaptureConsentService(
    new PostgresCaptureConsents(pool),
    new IngestCaptureOwnerContext(config.INGEST_INTERNAL_URL, key, config.SERVICE_KEY_ID),
  );
}
const app = accountApp(
  new AccountService(
    new PostgresAccount(pool),
    config.DEFAULT_CELL_ID,
    configuredProfiles(pool, config.WORKOS_PROFILE_API_KEY),
  ),
  (token) => workos.verify(token),
  new ServiceIdentity("account", JSON.parse(config.SERVICE_TRUSTED_JWKS)),
  new ModelUsageService(new PostgresModelUsage(pool)),
  captureConsents,
  new CaptureModelUsageService(
    new PostgresCaptureModelUsage(pool),
    captureReadiness,
    config.CAPTURE_MODEL_ADMISSION_ENABLED === "true" &&
      config.CAPTURE_PROCESSING_ENABLED === "true",
  ),
);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: "0.0.0.0", port: config.PORT });
