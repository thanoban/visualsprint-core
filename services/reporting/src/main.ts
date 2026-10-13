import { z } from "zod";
import { ServiceIdentity } from "@visualsprint/platform";
import { runtime } from "./runtime.js";
import { reportingApp } from "./http/app.js";
const config = z
  .object({
    GATEWAY_PUBLIC_JWKS: z.string().min(1),
    WORKSPACE_PUBLIC_JWKS: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(4107),
  })
  .parse(process.env);
const { pool, service } = await runtime();
const users = new ServiceIdentity("reporting", {
  gateway: JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,
});
const cleanup = new ServiceIdentity("reporting", {
  workspace: JSON.parse(config.WORKSPACE_PUBLIC_JWKS).keys,
});
const app = reportingApp(
  service,
  async (token) => (await users.verify(token)).actor,
  async (token) => (await cleanup.verify(token)).actor,
);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: "0.0.0.0", port: config.PORT });
