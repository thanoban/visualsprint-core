import { setTimeout } from "node:timers/promises";
import { runtime } from "./runtime.js";
const { pool, repository, service } = await runtime();
const abort = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort());
try {
  while (!abort.signal.aborted) {
    try {
      const due = await repository.due();
      for (let offset = 0; offset < due.length && !abort.signal.aborted; offset += 5)
        await Promise.all(
          due.slice(offset, offset + 5).map(async (ref) => {
            try {
              await service.work(ref.workspaceId, ref.connectionId);
              await repository.defer(ref.workspaceId, ref.connectionId, 30);
            } catch {
              console.error(JSON.stringify({ code: "CALENDAR_RECOVERY_PENDING" }));
              await repository.defer(ref.workspaceId, ref.connectionId, 60);
            }
          }),
        );
    } catch {
      console.error(JSON.stringify({ code: "CALENDAR_SCHEDULER_UNAVAILABLE" }));
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
