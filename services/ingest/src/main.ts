import { importJWK } from "jose";
import { z } from "zod";
import { assertRuntimeRole, databasePool, ServiceIdentity } from "@visualsprint/platform";
import { CaptureService } from "./application/capture-service.js";
import { Authorities } from "./infrastructure/authorities.js";
import { PostgresCapture } from "./infrastructure/store.js";
import { RecallProvider } from "./infrastructure/recall.js";
import { RecallSignatures } from "./infrastructure/webhook-signature.js";
import { ingestApp } from "./http/app.js";
const config = z
  .object({
    INGEST_DATABASE_URL: z.string().min(1),
    WORKSPACE_INTERNAL_URL: z.string().url(),
    ACCOUNT_INTERNAL_URL: z.string().url(),
    SERVICE_PRIVATE_JWK: z.string().min(1),
    SERVICE_KEY_ID: z.string().min(1),
    GATEWAY_PUBLIC_JWKS: z.string().min(1),
    INTEGRATION_PUBLIC_JWKS: z.string().optional(),
    INTELLIGENCE_PUBLIC_JWKS: z.string().optional(),
    REPORTING_PUBLIC_JWKS: z.string().optional(),
    WORKSPACE_PUBLIC_JWKS: z.string().optional(),
    RECALL_API_KEY: z.string().min(1),
    RECALL_REGION: z.enum(["us-west-2", "us-east-1", "eu-central-1", "ap-northeast-1"]),
    RECALL_WEBHOOK_URL: z.string().url(),
    RECALL_WEBHOOK_SECRETS: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(4104),
  })
  .parse(process.env);
const privateKey = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
if (privateKey instanceof Uint8Array) throw new Error("INVALID_SERVICE_SIGNING_KEY");
const pool = databasePool(config.INGEST_DATABASE_URL);
await assertRuntimeRole(pool);
const authorities = new Authorities(
  config.WORKSPACE_INTERNAL_URL,
  config.ACCOUNT_INTERNAL_URL,
  privateKey,
  config.SERVICE_KEY_ID,
);
const identity = new ServiceIdentity("ingest", {
  gateway: JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,
});
const readIdentity = new ServiceIdentity("ingest", {
  gateway: JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,
  ...(config.INTELLIGENCE_PUBLIC_JWKS
    ? { intelligence: JSON.parse(config.INTELLIGENCE_PUBLIC_JWKS).keys }
    : {}),
  ...(config.REPORTING_PUBLIC_JWKS
    ? { reporting: JSON.parse(config.REPORTING_PUBLIC_JWKS).keys }
    : {}),
});
const calendarIdentity = new ServiceIdentity(
  "ingest",
  config.INTEGRATION_PUBLIC_JWKS
    ? { integration: JSON.parse(config.INTEGRATION_PUBLIC_JWKS).keys }
    : {},
);
const service = new CaptureService(
  new PostgresCapture(pool),
  authorities,
  authorities,
  new RecallProvider(config.RECALL_API_KEY, config.RECALL_REGION),
  config.RECALL_WEBHOOK_URL,
);
const app = ingestApp(
  service,
  async (token) => (await identity.verify(token)).actor,
  new RecallSignatures(JSON.parse(config.RECALL_WEBHOOK_SECRETS)),
  async (token) => (await calendarIdentity.verify(token)).actor,
  async (token) => (await readIdentity.verify(token)).actor,
  async (token) =>
    (
      await new ServiceIdentity(
        "ingest",
        config.WORKSPACE_PUBLIC_JWKS
          ? { workspace: JSON.parse(config.WORKSPACE_PUBLIC_JWKS).keys }
          : {},
      ).verify(token)
    ).actor,
);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: "0.0.0.0", port: config.PORT });
