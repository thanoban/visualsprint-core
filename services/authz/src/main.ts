import { z } from "zod";
import { ServiceIdentity } from "@visualsprint/platform";
import { authzApp } from "./app.js";
import { OpenFgaPolicy } from "./policy.js";

const config = z
  .object({
    OPENFGA_URL: z.string().url(),
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
const app = authzApp(
  new OpenFgaPolicy(
    config.OPENFGA_URL,
    config.OPENFGA_API_KEY,
    config.OPENFGA_STORE_ID,
    config.OPENFGA_MODEL_ID,
  ),
  async (token) => {
    const delegation = await identity.verify(token);
    if (delegation.caller !== "workspace") throw new Error("UNTRUSTED_CALLER");
    return delegation.actor;
  },
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ port: config.PORT, host: "0.0.0.0" });
