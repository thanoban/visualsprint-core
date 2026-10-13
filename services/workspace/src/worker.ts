import { setTimeout } from "node:timers/promises";
import { importJWK } from "jose";
import { z } from "zod";
import { databasePool, assertRuntimeRole } from "@visualsprint/platform";
import { deletionRuntime } from "./infrastructure/deletion-runtime.js";
const config = z
  .object({
    WORKSPACE_DATABASE_URL: z.string().min(1),
    SERVICE_PRIVATE_JWK: z.string().min(1),
    SERVICE_KEY_ID: z.string().min(1),
    DELETION_SERVICE_ORIGINS: z.string().default("{}"),
  })
  .parse(process.env);
const key = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
if (key instanceof Uint8Array) throw new Error("INVALID_SERVICE_SIGNING_KEY");
const pool = databasePool(config.WORKSPACE_DATABASE_URL);
await assertRuntimeRole(pool);
const { repository, service } = deletionRuntime(
  pool,
  {
    async active() {
      throw new Error("WORKER_IS_NOT_USER_API");
    },
    async manage() {
      throw new Error("WORKER_IS_NOT_USER_API");
    },
  },
  key,
  config.SERVICE_KEY_ID,
  config.DELETION_SERVICE_ORIGINS,
);
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
try {
  while (!abort.signal.aborted) {
    try {
      for (const ref of await repository.due()) {
        if (abort.signal.aborted) break;
        await service.work(ref.workspaceId, ref.id);
      }
    } catch {
      console.error(JSON.stringify({ code: "DELETION_RECOVERY_PENDING" }));
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
