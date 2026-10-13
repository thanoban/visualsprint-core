import { z } from "zod";
import { ServiceIdentity, databasePool, assertRuntimeRole } from "@visualsprint/platform";
import { PostgresAuthzDeletions } from "./deletion-store.js";
import { AuthzDeletionService } from "./deletion-service.js";
import { OpenFgaMeetingPurge } from "./deletion-provider.js";
import { authzDeletionRoutes } from "./deletion-routes.js";
import { authzApp } from "./app.js";
import { OpenFgaPolicy } from "./policy.js";

const config = z
  .object({
    OPENFGA_URL: z.string().url(),
    AUTHZ_DATABASE_URL: z.string().min(1),
    OPENFGA_API_KEY: z.string().min(1),
    OPENFGA_STORE_ID: z.string().min(1),
    OPENFGA_MODEL_ID: z.string().min(1),
    WORKSPACE_PUBLIC_JWKS: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(4103),
  })
  .parse(process.env);
const identity = new ServiceIdentity("authz", {
  workspace: JSON.parse(config.WORKSPACE_PUBLIC_JWKS).keys,
});
const pool = databasePool(config.AUTHZ_DATABASE_URL);
await assertRuntimeRole(pool);
const deletions = new PostgresAuthzDeletions(pool);
const app = authzApp(
  new OpenFgaPolicy(
    config.OPENFGA_URL,
    config.OPENFGA_API_KEY,
    config.OPENFGA_STORE_ID,
    config.OPENFGA_MODEL_ID,
    deletions,
  ),
  async (token) => {
    const delegation = await identity.verify(token);
    if (delegation.caller !== "workspace") throw new Error("UNTRUSTED_CALLER");
    return delegation.actor;
  },
);
authzDeletionRoutes(
  app,
  new AuthzDeletionService(
    deletions,
    new OpenFgaMeetingPurge(
      config.OPENFGA_URL,
      config.OPENFGA_API_KEY,
      config.OPENFGA_STORE_ID,
      config.OPENFGA_MODEL_ID,
    ),
  ),
  async (token) => (await identity.verify(token)).actor,
);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ port: config.PORT, host: "0.0.0.0" });
