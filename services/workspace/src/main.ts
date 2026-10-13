import { importJWK } from "jose";
import { z } from "zod";
import { AppError, assertRuntimeRole, databasePool, ServiceIdentity } from "@visualsprint/platform";
import { WorkspaceService } from "./application/workspace.js";
import { PostgresWorkspace } from "./infrastructure/store.js";
import { AccountMemberships } from "./infrastructure/account-client.js";
import { AuthzPolicy } from "./infrastructure/policy-client.js";
import { workspaceApp } from "./http/app.js";
import { deletionRuntime } from "./infrastructure/deletion-runtime.js";

const config = z
  .object({
    WORKSPACE_DATABASE_URL: z.string().min(1),
    ACCOUNT_INTERNAL_URL: z.string().url(),
    AUTHZ_INTERNAL_URL: z.string().url(),
    SERVICE_PRIVATE_JWK: z.string().min(1),
    SERVICE_KEY_ID: z.string().min(1),
    GATEWAY_PUBLIC_JWKS: z.string().min(1),
    INGEST_PUBLIC_JWKS: z.string().optional(),
    INTEGRATION_PUBLIC_JWKS: z.string().optional(),
    INTELLIGENCE_PUBLIC_JWKS: z.string().optional(),
    REPORTING_PUBLIC_JWKS: z.string().optional(),
    WORKFLOW_PUBLIC_JWKS: z.string().optional(),
    NOTIFICATION_PUBLIC_JWKS: z.string().optional(),
    DELETION_SERVICE_ORIGINS: z.string().default("{}"),
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
const readers = {
  ...(config.INTELLIGENCE_PUBLIC_JWKS
    ? { intelligence: JSON.parse(config.INTELLIGENCE_PUBLIC_JWKS).keys }
    : {}),
  ...(config.REPORTING_PUBLIC_JWKS
    ? { reporting: JSON.parse(config.REPORTING_PUBLIC_JWKS).keys }
    : {}),
  ...(config.WORKFLOW_PUBLIC_JWKS
    ? { workflow: JSON.parse(config.WORKFLOW_PUBLIC_JWKS).keys }
    : {}),
};
const readerIdentity = new ServiceIdentity("workspace", readers);
const readIdentity = new ServiceIdentity("workspace", {
  gateway: JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,
  ...readers,
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
const calendarIdentity = new ServiceIdentity(
  "workspace",
  config.INTEGRATION_PUBLIC_JWKS
    ? { integration: JSON.parse(config.INTEGRATION_PUBLIC_JWKS).keys }
    : {},
);
await assertRuntimeRole(pool);
const service = new WorkspaceService(
  new PostgresWorkspace(pool),
  new AccountMemberships(config.ACCOUNT_INTERNAL_URL, privateKey, config.SERVICE_KEY_ID),
  new AuthzPolicy(config.AUTHZ_INTERNAL_URL, privateKey, config.SERVICE_KEY_ID),
);
const deletions = deletionRuntime(
  pool,
  {
    active: (actor) =>
      new AccountMemberships(
        config.ACCOUNT_INTERNAL_URL,
        privateKey,
        config.SERVICE_KEY_ID,
      ).requireActive(actor),
    manage: async (actor, meetingId) => {
      await service.manageContext(actor, meetingId);
    },
  },
  privateKey,
  config.SERVICE_KEY_ID,
  config.DELETION_SERVICE_ORIGINS,
);
const app = workspaceApp(
  service,
  async (token) => (await identity.verify(token)).actor,
  async (token) => {
    const hop = await internalIdentity.verify(token);
    if (hop.caller !== "ingest") throw new AppError("FORBIDDEN", 403);
    return hop.actor;
  },
  async (token) => (await calendarIdentity.verify(token)).actor,
  async (token) => (await readerIdentity.verify(token)).actor,
  async (token) => (await readIdentity.verify(token)).actor,
  deletions.service,
  async (token) =>
    (
      await new ServiceIdentity(
        "workspace",
        config.NOTIFICATION_PUBLIC_JWKS
          ? { notification: JSON.parse(config.NOTIFICATION_PUBLIC_JWKS).keys }
          : {},
      ).verify(token)
    ).actor,
);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ port: config.PORT, host: "0.0.0.0" });
