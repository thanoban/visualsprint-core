import { setTimeout } from "node:timers/promises";
import { importJWK } from "jose";
import { z } from "zod";
import { assertRuntimeRole, databasePool } from "@visualsprint/platform";
import { CaptureService } from "./application/capture-service.js";
import { Authorities } from "./infrastructure/authorities.js";
import { PostgresCapture } from "./infrastructure/store.js";
import { RecallProvider } from "./infrastructure/recall.js";
const config = z
  .object({
    INGEST_DATABASE_URL: z.string().min(1),
    WORKSPACE_INTERNAL_URL: z.string().url(),
    ACCOUNT_INTERNAL_URL: z.string().url(),
    SERVICE_PRIVATE_JWK: z.string().min(1),
    SERVICE_KEY_ID: z.string().min(1),
    RECALL_API_KEY: z.string().min(1),
    RECALL_REGION: z.enum(["us-west-2", "us-east-1", "eu-central-1", "ap-northeast-1"]),
    RECALL_WEBHOOK_URL: z.string().url(),
  })
  .parse(process.env);
const key = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
if (key instanceof Uint8Array) throw new Error("INVALID_SERVICE_SIGNING_KEY");
const pool = databasePool(config.INGEST_DATABASE_URL);
await assertRuntimeRole(pool);
const repository = new PostgresCapture(pool);
const authorities = new Authorities(
  config.WORKSPACE_INTERNAL_URL,
  config.ACCOUNT_INTERNAL_URL,
  key,
  config.SERVICE_KEY_ID,
);
const service = new CaptureService(
  repository,
  authorities,
  authorities,
  new RecallProvider(config.RECALL_API_KEY, config.RECALL_REGION),
  config.RECALL_WEBHOOK_URL,
);
const abort = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort());
try {
  while (!abort.signal.aborted) {
    try {
      const due = await repository.due();
      // Five bounded tasks; database leases coordinate replicas and crash recovery.
      for (let offset = 0; offset < due.length && !abort.signal.aborted; offset += 5)
        await Promise.all(
          due.slice(offset, offset + 5).map(async (ref) => {
            try {
              await service.work(ref.workspaceId, ref.requestId);
              await repository.reschedule(ref.workspaceId, ref.requestId);
            } catch {
              console.error(JSON.stringify({ code: "CAPTURE_RECONCILIATION_FAILED" }));
              await repository.reschedule(ref.workspaceId, ref.requestId, 30);
            }
          }),
        );
    } catch {
      console.error(JSON.stringify({ code: "CAPTURE_SCHEDULER_UNAVAILABLE" }));
    }
    try {
      await setTimeout(1000, undefined, { signal: abort.signal });
    } catch {
      /* shutdown */
    }
  }
} finally {
  await pool.end();
}
