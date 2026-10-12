import { importJWK } from "jose";
import { z } from "zod";
import { AppError, assertRuntimeRole, databasePool, ServiceIdentity } from "@visualsprint/platform";
import { WorkspaceService } from "./application/workspace.js";
import { PostgresWorkspace } from "./infrastructure/store.js";
import { AccountMemberships } from "./infrastructure/account-client.js";
import { AuthzPolicy } from "./infrastructure/policy-client.js";
import { workspaceApp } from "./http/app.js";

const config = z
  .object({
    WORKSPACE_DATABASE_URL: z.string().min(1),
    ACCOUNT_INTERNAL_URL: z.string().url(),
    AUTHZ_INTERNAL_URL: z.string().url(),
    SERVICE_PRIVATE_JWK: z.string().min(1),
    SERVICE_KEY_ID: z.string().min(1),
    GATEWAY_PUBLIC_JWKS: z.string().min(1),
    INGEST_PUBLIC_JWKS: z.string().optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(4102),
  })
  .parse(process.env);
const accountUrl = new URL(config.ACCOUNT_INTERNAL_URL);
if (
  accountUrl.username ||
  accountUrl.password ||
  (accountUrl.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      accountUrl.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(accountUrl.hostname)
    ))
) {
  throw new Error("INVALID_ACCOUNT_INTERNAL_URL");
}
const privateKey = await importJWK(JSON.parse(config.SERVICE_PRIVATE_JWK), "EdDSA");
if (privateKey instanceof Uint8Array) throw new Error("INVALID_SERVICE_SIGNING_KEY");
const identity = new ServiceIdentity("workspace", {
  gateway: JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,
});
const internalIdentity = new ServiceIdentity(
  "workspace",
  config.INGEST_PUBLIC_JWKS
    ? {
        ingest: JSON.parse(config.INGEST_PUBLIC_JWKS).keys,
      }
    : {},
);
const pool = databasePool(config.WORKSPACE_DATABASE_URL);
await assertRuntimeRole(pool);
const app = workspaceApp(
  new WorkspaceService(
    new PostgresWorkspace(pool),
    new AccountMemberships(config.ACCOUNT_INTERNAL_URL, privateKey, config.SERVICE_KEY_ID),
    new AuthzPolicy(config.AUTHZ_INTERNAL_URL, privateKey, config.SERVICE_KEY_ID),
  ),
  async (token) => (await identity.verify(token)).actor,
  async (token) => {
    const hop = await internalIdentity.verify(token);
    if (hop.caller !== "ingest") throw new AppError("FORBIDDEN", 403);
    return hop.actor;
  },
);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ port: config.PORT, host: "0.0.0.0" });
