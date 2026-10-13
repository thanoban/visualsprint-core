import { setTimeout } from "node:timers/promises";
import { runtime } from "./runtime.js";
const { pool, repository, service } = await runtime();
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
try {
  while (!abort.signal.aborted) {
    try {
      await repository.expire(new Date());
      for (const row of await repository.due()) {
        if (abort.signal.aborted) break;
        await service.work(row.workspaceId, row.id);
      }
    } catch {
      console.error(JSON.stringify({ code: "REPORTING_WORK_PENDING" }));
    }
    try {
      await setTimeout(1000, undefined, { signal: abort.signal });
    } catch {
      /*shutdown*/
    }
  }
} finally {
  await pool.end();
}
