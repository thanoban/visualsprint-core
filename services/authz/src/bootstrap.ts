import { safeOrigin } from "./policy.js";
import { authorizationModel } from "./model.js";

export async function bootstrap(origin: string, apiKey: string, name: string) {
  const url = safeOrigin(origin);
  async function post(path: string, body: unknown) {
    const response = await fetch(new URL(path, url), {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("AUTHZ_BOOTSTRAP_FAILED");
    return (await response.json()) as Record<string, string>;
  }
  const store = await post("/stores", { name });
  const model = await post(`/stores/${store.id}/authorization-models`, authorizationModel);
  return { storeId: store.id!, modelId: model.authorization_model_id! };
}
if (process.argv[1]?.endsWith("bootstrap.ts")) {
  if (!process.env.OPENFGA_URL || !process.env.OPENFGA_API_KEY)
    throw new Error("AUTHZ_CONFIG_REQUIRED");
  console.log(
    JSON.stringify(
      await bootstrap(
        process.env.OPENFGA_URL,
        process.env.OPENFGA_API_KEY,
        process.env.OPENFGA_STORE_NAME ?? "visualsprint",
      ),
    ),
  );
}
