import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { databasePool, assertRuntimeRole } from "@visualsprint/platform";
import { AzureEvents } from "@visualsprint/messaging";
import { IntelligenceEventOutbox } from "./infrastructure/event-outbox.js";
import { runtime } from "./runtime.js";
const config = z
  .object({
    INTELLIGENCE_DATABASE_URL: z.string().min(1),
    SERVICE_BUS_NAMESPACE: z.string().min(1),
    AZURE_CLIENT_ID: z.string().uuid().optional(),
    INTELLIGENCE_CAPTURE_SUBSCRIPTION: z
      .string()
      .regex(/^[a-z][a-z0-9.-]{0,99}$/)
      .default("capture-extraction-v1"),
  })
  .parse(process.env);
const extractionRuntime =
  process.env.INTELLIGENCE_CAPTURE_EXTRACTION_ENABLED === "true" ? await runtime() : undefined;
const pool = extractionRuntime?.pool ?? databasePool(config.INTELLIGENCE_DATABASE_URL);
await assertRuntimeRole(pool);
const repository = new IntelligenceEventOutbox(pool);
const bus = new AzureEvents(config.SERVICE_BUS_NAMESPACE, config.AZURE_CLIENT_ID);
const publisher = bus.publisher("vs-intelligence");
const captureSubscription = extractionRuntime?.extraction
  ? bus.subscriber(
      "vs-ingest",
      config.INTELLIGENCE_CAPTURE_SUBSCRIPTION,
      async (event) => {
        if (event.type === "capture.processing.ready.v1")
          await extractionRuntime.extraction!.consume(event);
      },
      () => {
        console.error(JSON.stringify({ code: "CAPTURE_EXTRACTION_INGRESS_UNAVAILABLE" }));
      },
    )
  : undefined;
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
try {
  while (!abort.signal.aborted) {
    try {
      for (const workspaceId of await repository.workspaces()) {
        if (abort.signal.aborted) break;
        try {
          const count = await repository.publish(workspaceId, publisher);
          await repository.defer(workspaceId, count === 20 ? 1 : 5);
        } catch {
          console.error(
            JSON.stringify({ code: "OUTBOX_DELIVERY_UNKNOWN", service: "intelligence" }),
          );
          await repository.defer(workspaceId, 30);
        }
      }
    } catch {
      console.error(
        JSON.stringify({ code: "OUTBOX_SCHEDULER_UNAVAILABLE", service: "intelligence" }),
      );
    }
    try {
      await setTimeout(1000, undefined, { signal: abort.signal });
    } catch {
      /* shutdown */
    }
  }
} finally {
  await captureSubscription?.close();
  await publisher.close();
  await bus.close();
  await pool.end();
}
