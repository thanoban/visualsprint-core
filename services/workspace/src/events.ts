import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { assertRuntimeRole, databasePool } from "@visualsprint/platform";
import { AzureEvents } from "@visualsprint/messaging";
import { PostgresWorkspace } from "./infrastructure/store.js";
const config = z
  .object({
    WORKSPACE_DATABASE_URL: z.string().min(1),
    SERVICE_BUS_NAMESPACE: z.string().min(1),
    AZURE_CLIENT_ID: z.string().uuid().optional(),
  })
  .parse(process.env);
const pool = databasePool(config.WORKSPACE_DATABASE_URL);
await assertRuntimeRole(pool);
const repository = new PostgresWorkspace(pool);
const bus = new AzureEvents(config.SERVICE_BUS_NAMESPACE, config.AZURE_CLIENT_ID);
const publisher = bus.publisher("vs-workspace");
const abort = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort());
try {
  while (!abort.signal.aborted) {
    try {
      for (const workspaceId of await repository.eventWorkspaces()) {
        if (abort.signal.aborted) break;
        try {
          const count = await repository.publish(workspaceId, publisher);
          await repository.deferEvents(workspaceId, count === 20 ? 1 : 5);
        } catch {
          console.error(JSON.stringify({ code: "OUTBOX_DELIVERY_UNKNOWN", service: "workspace" }));
          await repository.deferEvents(workspaceId, 30);
        }
      }
    } catch {
      console.error(JSON.stringify({ code: "OUTBOX_SCHEDULER_UNAVAILABLE", service: "workspace" }));
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
