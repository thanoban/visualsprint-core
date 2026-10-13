import { z } from "zod";
import { ServiceIdentity } from "@visualsprint/platform";
import { runtime } from "./runtime.js";
import { workflowApp } from "./http/app.js";
const config = z
  .object({
    GATEWAY_PUBLIC_JWKS: z.string().min(1),
    INTEGRATION_PUBLIC_JWKS: z.string().min(1).optional(),
    WORKSPACE_PUBLIC_JWKS: z.string().min(1).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(4108),
  })
  .parse(process.env);
const { pool, service } = await runtime();
const gateway = new ServiceIdentity("workflow", {
  gateway: JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,
});
const integration = config.INTEGRATION_PUBLIC_JWKS
  ? new ServiceIdentity("workflow", {
      integration: JSON.parse(config.INTEGRATION_PUBLIC_JWKS).keys,
    })
  : undefined;
const deletion = config.WORKSPACE_PUBLIC_JWKS
  ? new ServiceIdentity("workflow", { workspace: JSON.parse(config.WORKSPACE_PUBLIC_JWKS).keys })
  : undefined;
const app = workflowApp(
  service,
  async (token) => (await gateway.verify(token)).actor,
  integration ? async (token) => (await integration.verify(token)).actor : undefined,
  deletion ? async (token) => (await deletion.verify(token)).actor : undefined,
);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: "0.0.0.0", port: config.PORT });
