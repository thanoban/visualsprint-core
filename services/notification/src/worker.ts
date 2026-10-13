import { setTimeout } from "node:timers/promises";
import { runtime } from "./runtime.js";
const { pool, repository, service } = await runtime();
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
try {
  while (!abort.signal.aborted) {
    try {
      for (const ref of await repository.due()) {
        if (abort.signal.aborted) break;
        try {
          await service.work(ref.workspaceId, ref.deliveryId);
          await repository.reschedule(ref.workspaceId, ref.deliveryId);
        } catch {
          console.error(JSON.stringify({ code: "NOTIFICATION_WORK_FAILED" }));
          await repository.reschedule(ref.workspaceId, ref.deliveryId, 30);
        }
      }
    } catch {
      console.error(JSON.stringify({ code: "NOTIFICATION_SCHEDULER_UNAVAILABLE" }));
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
