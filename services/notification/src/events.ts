import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { databasePool, assertRuntimeRole } from "@visualsprint/platform";
import { AzureEvents } from "@visualsprint/messaging";
import { PostgresNotifications } from "./infrastructure/store.js";
import { authorizedEvent } from "./application/notification.js";
import { configuredRealtime } from "./infrastructure/realtime-runtime.js";
import { realtimePublisher } from "./infrastructure/realtime-publisher.js";
const config = z
  .object({
    NOTIFICATION_DATABASE_URL: z.string().min(1),
    SERVICE_BUS_NAMESPACE: z.string().min(1),
    AZURE_CLIENT_ID: z.string().uuid().optional(),
    NOTIFICATION_REALTIME_ENABLED: z.enum(["true", "false"]).default("false"),
    AZURE_WEB_PUBSUB_ENDPOINT: z.string().url().optional(),
  })
  .parse(process.env);
const pool = databasePool(config.NOTIFICATION_DATABASE_URL);
await assertRuntimeRole(pool);
const repository = new PostgresNotifications(pool);
const bus = new AzureEvents(config.SERVICE_BUS_NAMESPACE, config.AZURE_CLIENT_ID);
const publisher = bus.publisher("vs-notification");
const deliveryPublisher = realtimePublisher(
  publisher,
  configuredRealtime({
    enabled: config.NOTIFICATION_REALTIME_ENABLED === "true",
    endpoint: config.AZURE_WEB_PUBSUB_ENDPOINT,
    identityClientId: config.AZURE_CLIENT_ID,
  }),
);
const subscribers = ["intelligence", "workflow", "ingest"].map((caller) =>
  bus.subscriber(
    `vs-${caller}`,
    "notification",
    async (event) => {
      if (authorizedEvent(caller, event))
        await repository.transaction(event.workspaceId, (tx) => tx.consume(event));
    },
    () => console.error(JSON.stringify({ code: "NOTIFICATION_EVENT_CONSUMPTION_FAILED" })),
  ),
);
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
try {
  while (!abort.signal.aborted) {
    try {
      for (const workspaceId of await repository.eventWorkspaces()) {
        if (abort.signal.aborted) break;
        try {
          const count = await repository.publish(workspaceId, deliveryPublisher);
          await repository.deferEvents(workspaceId, count === 20 ? 1 : 5);
        } catch {
          console.error(JSON.stringify({ code: "NOTIFICATION_OUTBOX_DELIVERY_UNKNOWN" }));
          await repository.deferEvents(workspaceId, 30);
        }
      }
    } catch {
      console.error(JSON.stringify({ code: "NOTIFICATION_OUTBOX_UNAVAILABLE" }));
    }
    try {
      await setTimeout(1000, undefined, { signal: abort.signal });
    } catch {
      /* shutdown */
    }
  }
} finally {
  await Promise.all(subscribers.map((subscriber) => subscriber.close()));
  await publisher.close();
  await bus.close();
  await pool.end();
}
