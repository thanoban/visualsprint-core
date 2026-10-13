import { importJWK } from "jose";
import { z } from "zod";
import { databasePool, assertRuntimeRole } from "@visualsprint/platform";
import { WorkflowService } from "./application/workflow.js";
import { PostgresWorkflow } from "./infrastructure/store.js";
import {
  WorkspaceActions,
  IntegrationActions,
  DisabledConnector,
} from "./infrastructure/clients.js";
export async function runtime() {
  const config = z
    .object({
      WORKFLOW_DATABASE_URL: z.string().min(1),
      WORKSPACE_INTERNAL_URL: z.string().url(),
      INTEGRATION_INTERNAL_URL: z.string().url().optional(),
      SERVICE_PRIVATE_JWK: z.string().min(1),
      SERVICE_KEY_ID: z.string().min(1),
    })
    .parse(process.env);
  const key = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
  if (key instanceof Uint8Array) throw new Error("INVALID_SERVICE_KEY");
  const pool = databasePool(config.WORKFLOW_DATABASE_URL);
  await assertRuntimeRole(pool);
  const repository = new PostgresWorkflow(pool);
  return {
    pool,
    repository,
    service: new WorkflowService(
      repository,
      new WorkspaceActions(config.WORKSPACE_INTERNAL_URL, key, config.SERVICE_KEY_ID),
      config.INTEGRATION_INTERNAL_URL
        ? new IntegrationActions(config.INTEGRATION_INTERNAL_URL, key, config.SERVICE_KEY_ID)
        : new DisabledConnector(),
    ),
  };
}
