import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { importJWK } from "jose";
import { assertRuntimeRole, databasePool } from "@visualsprint/platform";
import { CaptureProcessingService } from "../application/capture-processing.js";
import { CaptureProcessingPublisher } from "../application/capture-processing-publication.js";
import { PostgresCaptureProcessing } from "./capture-processing-store.js";
import { PostgresCapturePublications } from "./capture-processing-publication-store.js";
import { CaptureProcessingAuthorities } from "./capture-processing-authority.js";
export const processingPublisherConfig = z.object({
  INGEST_DATABASE_URL: z.string().min(1),
  WORKSPACE_INTERNAL_URL: z.string().url(),
  ACCOUNT_INTERNAL_URL: z.string().url(),
  SERVICE_PRIVATE_JWK: z.string().min(1),
  SERVICE_KEY_ID: z.string().min(1),
  CAPTURE_PROCESSING_ENABLED: z.literal("true"),
  CAPTURE_EXTRACTION_PUBLISH_ENABLED: z.literal("true"),
});
export async function runCaptureProcessingPublisher(
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const config = processingPublisherConfig.parse(environment);
  const key = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
  if (key instanceof Uint8Array) throw new Error("INVALID_SERVICE_SIGNING_KEY");
  const pool = databasePool(config.INGEST_DATABASE_URL);
  try {
    await assertRuntimeRole(pool);
    if (
      !(
        await pool.query(
          "SELECT to_regclass('public.capture_processing_publications') IS NOT NULL AND to_regclass('public.capture_processing_publish_index') IS NOT NULL AS installed",
        )
      ).rows[0]?.installed
    )
      throw new Error("CAPTURE_PUBLICATION_MIGRATION_REQUIRED");
    const repository = new PostgresCapturePublications(pool),
      service = new CaptureProcessingPublisher(
        repository,
        new CaptureProcessingService(
          new PostgresCaptureProcessing(pool),
          new CaptureProcessingAuthorities(
            { account: config.ACCOUNT_INTERNAL_URL, workspace: config.WORKSPACE_INTERNAL_URL },
            key,
            config.SERVICE_KEY_ID,
          ),
        ),
      );
    while (!signal.aborted) {
      try {
        for (const ref of await repository.due()) {
          if (signal.aborted) break;
          try {
            await service.work(ref.workspaceId, ref.captureId);
          } catch {
            console.error(JSON.stringify({ code: "CAPTURE_PUBLICATION_RECONCILIATION_PENDING" }));
            await repository.defer(ref.workspaceId, ref.captureId);
          }
        }
      } catch {
        console.error(JSON.stringify({ code: "CAPTURE_PUBLICATION_SCHEDULER_UNAVAILABLE" }));
      }
      try {
        await setTimeout(1000, undefined, { signal });
      } catch {
        /* shutdown */
      }
    }
  } finally {
    await pool.end();
  }
}
