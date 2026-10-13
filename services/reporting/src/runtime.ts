import { importJWK } from "jose";
import { z } from "zod";
import { assertRuntimeRole, databasePool } from "@visualsprint/platform";
import { PostgresExports } from "./infrastructure/store.js";
import { HttpExportSources } from "./infrastructure/source-client.js";
import { ReportingService } from "./application/reporting.js";
export async function runtime() {
  const config = z
    .object({
      REPORTING_DATABASE_URL: z.string().min(1),
      WORKSPACE_INTERNAL_URL: z.string().url(),
      INGEST_INTERNAL_URL: z.string().url(),
      SERVICE_PRIVATE_JWK: z.string().min(1),
      SERVICE_KEY_ID: z.string().min(1),
    })
    .parse(process.env);
  const key = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
  if (key instanceof Uint8Array) throw new Error("INVALID_SERVICE_KEY");
  const pool = databasePool(config.REPORTING_DATABASE_URL);
  await assertRuntimeRole(pool);
  const repository = new PostgresExports(pool);
  return {
    pool,
    repository,
    service: new ReportingService(
      repository,
      new HttpExportSources(
        config.WORKSPACE_INTERNAL_URL,
        config.INGEST_INTERNAL_URL,
        key,
        config.SERVICE_KEY_ID,
      ),
    ),
  };
}
