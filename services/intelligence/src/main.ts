import { runtime } from "./runtime.js";
import { intelligenceApp } from "./http/app.js";
const {
  config,
  pool,
  service,
  identity,
  deletionIdentity,
  readIdentity,
  preparation,
  indexing,
  purgeDerived,
} = await runtime();
const app = intelligenceApp(
  service,
  async (token) => (await identity.verify(token)).actor,
  async (token) => (await deletionIdentity.verify(token)).actor,
  async (token) => (await readIdentity.verify(token)).actor,
  { ...(preparation ? { preparation } : {}), ...(indexing ? { indexing } : {}), purgeDerived },
);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: "0.0.0.0", port: config.PORT });
