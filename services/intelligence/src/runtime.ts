import { importJWK } from "jose";
import { ManagedIdentityCredential } from "@azure/identity";
import { z } from "zod";
import { assertRuntimeRole, databasePool, ServiceIdentity } from "@visualsprint/platform";
import { IntelligenceService } from "./application/intelligence.js";
import { PostgresIntelligence } from "./infrastructure/store.js";
import { AuthorizedSources } from "./infrastructure/sources.js";
import { AzureTextModel, UnconfiguredModel } from "./infrastructure/azure-model.js";
export async function runtime() {
  const config = z
    .object({
      INTELLIGENCE_DATABASE_URL: z.string().min(1),
      ACCOUNT_INTERNAL_URL: z.string().url(),
      WORKSPACE_INTERNAL_URL: z.string().url(),
      INGEST_INTERNAL_URL: z.string().url(),
      SERVICE_PRIVATE_JWK: z.string().min(1),
      SERVICE_KEY_ID: z.string().min(1),
      GATEWAY_PUBLIC_JWKS: z.string().min(1),
      WORKSPACE_PUBLIC_JWKS: z.string().optional(),
      AZURE_OPENAI_ENDPOINT: z.preprocess(
        (value) => (value === "" ? undefined : value),
        z.string().url().optional(),
      ),
      AZURE_OPENAI_DEPLOYMENT: z.preprocess(
        (value) => (value === "" ? undefined : value),
        z.string().optional(),
      ),
      AZURE_CLIENT_ID: z.string().optional(),
      PORT: z.coerce.number().int().min(1).max(65535).default(4106),
    })
    .parse(process.env);
  if (Boolean(config.AZURE_OPENAI_ENDPOINT) !== Boolean(config.AZURE_OPENAI_DEPLOYMENT))
    throw new Error("INCOMPLETE_MODEL_CONFIGURATION");
  const privateKey = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
  if (privateKey instanceof Uint8Array) throw new Error("INVALID_SERVICE_SIGNING_KEY");
  const identity = new ServiceIdentity("intelligence", {
    gateway: JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,
  });
  const deletionIdentity = new ServiceIdentity(
    "intelligence",
    config.WORKSPACE_PUBLIC_JWKS
      ? { workspace: JSON.parse(config.WORKSPACE_PUBLIC_JWKS).keys }
      : {},
  );
  const readIdentity = new ServiceIdentity("intelligence",{gateway:JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,...(config.WORKSPACE_PUBLIC_JWKS?{workspace:JSON.parse(config.WORKSPACE_PUBLIC_JWKS).keys}:{})});
  const pool = databasePool(config.INTELLIGENCE_DATABASE_URL);
  try {
    await assertRuntimeRole(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const repository = new PostgresIntelligence(pool);
  const sources = new AuthorizedSources(
    {
      account: config.ACCOUNT_INTERNAL_URL,
      workspace: config.WORKSPACE_INTERNAL_URL,
      ingest: config.INGEST_INTERNAL_URL,
    },
    privateKey,
    config.SERVICE_KEY_ID,
  );
  const credential = config.AZURE_CLIENT_ID
    ? new ManagedIdentityCredential({ clientId: config.AZURE_CLIENT_ID })
    : new ManagedIdentityCredential();
  const model =
    config.AZURE_OPENAI_ENDPOINT && config.AZURE_OPENAI_DEPLOYMENT
      ? new AzureTextModel(
          config.AZURE_OPENAI_ENDPOINT,
          config.AZURE_OPENAI_DEPLOYMENT,
          async (signal) => {
            const token = await credential.getToken(
              "https://cognitiveservices.azure.com/.default",
              { abortSignal: signal },
            );
            if (!token) throw new Error("MODEL_IDENTITY_UNAVAILABLE");
            return token.token;
          },
        )
      : new UnconfiguredModel();
  return {
    config,
    pool,
    repository,
    service: new IntelligenceService(repository, sources, model),
    identity,
    deletionIdentity,
    readIdentity,
  };
}
