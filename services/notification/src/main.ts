import { z } from "zod";
import { ServiceIdentity } from "@visualsprint/platform";
import { runtime } from "./runtime.js";
import { notificationApp } from "./http/app.js";
const config = z
  .object({
    GATEWAY_PUBLIC_JWKS: z.string().min(1),
    EVENT_SOURCE_PUBLIC_JWKS: z.string().min(1).optional(),
    WORKSPACE_PUBLIC_JWKS: z.string().min(1).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(4109),
  })
  .parse(process.env);
const { pool, service } = await runtime();
const gateway = new ServiceIdentity("notification", {
  gateway: JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,
});
const event = config.EVENT_SOURCE_PUBLIC_JWKS
  ? new ServiceIdentity("notification", JSON.parse(config.EVENT_SOURCE_PUBLIC_JWKS))
  : undefined;
const workspace = config.WORKSPACE_PUBLIC_JWKS
  ? new ServiceIdentity("notification", {
      workspace: JSON.parse(config.WORKSPACE_PUBLIC_JWKS).keys,
    })
  : undefined;
const app = notificationApp(
  service,
  async (token) => (await gateway.verify(token)).actor,
  event ? (token) => event.verify(token) : undefined,
  workspace ? async (token) => (await workspace.verify(token)).actor : undefined,
);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: "0.0.0.0", port: config.PORT });
