import { setTimeout } from "node:timers/promises";
import { runtime } from "./runtime.js";
const {
  pool,
  repository,
  service,
  features,
  preparation,
  preparationRepository,
  indexing,
  indexRepository,
} = await runtime();
const abort = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort());
try {
  while (!abort.signal.aborted) {
    try {
      const target =
        features.INTELLIGENCE_WORKER_KIND === "preparation"
          ? { repository: preparationRepository!, service: preparation! }
          : features.INTELLIGENCE_WORKER_KIND === "indexing"
            ? { repository: indexRepository!, service: indexing! }
            : { repository, service };
      const due = await target.repository.due();
      for (let offset = 0; offset < due.length && !abort.signal.aborted; offset += 2)
        await Promise.all(
          due.slice(offset, offset + 2).map(async (ref) => {
            try {
              await target.service.work(ref.workspaceId, ref.id);
            } catch {
              console.error(JSON.stringify({ code: "INTELLIGENCE_RECOVERY_PENDING" }));
            }
          }),
        );
    } catch {
      console.error(JSON.stringify({ code: "INTELLIGENCE_SCHEDULER_UNAVAILABLE" }));
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
