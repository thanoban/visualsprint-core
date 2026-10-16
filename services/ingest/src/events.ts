import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { assertRuntimeRole, databasePool } from "@visualsprint/platform";
import { AzureEvents } from "@visualsprint/messaging";
import { PostgresCapture } from "./infrastructure/store.js";
import { runCaptureProcessingPublisher } from "./infrastructure/capture-processing-publisher-runtime.js";
const workerKind = z
  .enum(["publisher", "processing"])
  .default("publisher")
  .parse(process.env.INGEST_EVENT_WORKER_KIND);
const abort = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort());
if (workerKind === "processing") {
  await runCaptureProcessingPublisher(process.env, abort.signal);
} else {
  const config = z
    .object({
      INGEST_DATABASE_URL: z.string().min(1),
      SERVICE_BUS_NAMESPACE: z.string().min(1),
      AZURE_CLIENT_ID: z.string().uuid().optional(),
    })
    .parse(process.env);
  const pool = databasePool(config.INGEST_DATABASE_URL);
  await assertRuntimeRole(pool);
  const repository = new PostgresCapture(pool);
  const bus = new AzureEvents(config.SERVICE_BUS_NAMESPACE, config.AZURE_CLIENT_ID);
  const publisher = bus.publisher("vs-ingest");
  try {
    while (!abort.signal.aborted) {
      try {
        for (const workspaceId of await repository.eventWorkspaces()) {
          if (abort.signal.aborted) break;
          try {
            const count = await repository.publish(workspaceId, publisher);
            await repository.deferEvents(workspaceId, count === 20 ? 1 : 5);
          } catch {
            console.error(JSON.stringify({ code: "OUTBOX_DELIVERY_UNKNOWN", service: "ingest" }));
            await repository.deferEvents(workspaceId, 30);
          }
        }
      } catch {
        console.error(JSON.stringify({ code: "OUTBOX_SCHEDULER_UNAVAILABLE", service: "ingest" }));
      }
      try {
        await setTimeout(1000, undefined, { signal: abort.signal });
      } catch {
        /* shutdown */
      }
    }
  } finally {
    await publisher.close();
    await bus.close();
    await pool.end();
  }
}
