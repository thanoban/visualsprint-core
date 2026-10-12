import { z } from "zod";
import { ServiceIdentity } from "@visualsprint/platform";
import { integrationApp } from "./http/app.js";
import { runtime } from "./runtime.js";
const config = z
  .object({
    GATEWAY_PUBLIC_JWKS: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(4105),
  })
  .parse(process.env);
const { pool, service, providers } = await runtime();
const identity = new ServiceIdentity("integration", {
  gateway: JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,
});
const app = integrationApp(
  service,
  async (token) => (await identity.verify(token)).actor,
  Object.keys(providers),
);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: "0.0.0.0", port: config.PORT });
