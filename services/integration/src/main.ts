import { z } from "zod";
import { ServiceIdentity, AppError, bearer } from "@visualsprint/platform";
import { id } from "@visualsprint/contracts";
import { actionRoutes } from "./http/action-routes.js";
import { calendarPushRoutes } from "./http/calendar-push-routes.js";
import { integrationApp } from "./http/app.js";
import { runtime } from "./runtime.js";
const config = z
  .object({
    GATEWAY_PUBLIC_JWKS: z.string().min(1),
    WORKFLOW_PUBLIC_JWKS: z.string().optional(),
    WORKSPACE_PUBLIC_JWKS: z.string().optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(4105),
  })
  .parse(process.env);
const { pool, service, providers, actions, purge, push } = await runtime();
const identity = new ServiceIdentity("integration", {
  gateway: JSON.parse(config.GATEWAY_PUBLIC_JWKS).keys,
});
const app = integrationApp(
  service,
  async (token) => (await identity.verify(token)).actor,
  Object.keys(providers),
);
calendarPushRoutes(app, push);
if (actions) {
  const workflowIdentity = new ServiceIdentity(
    "integration",
    config.WORKFLOW_PUBLIC_JWKS ? { workflow: JSON.parse(config.WORKFLOW_PUBLIC_JWKS).keys } : {},
  );
  actionRoutes(
    app,
    actions,
    async (token) => (await identity.verify(token)).actor,
    async (token) => (await workflowIdentity.verify(token)).actor,
  );
}
const cleanupIdentity = new ServiceIdentity(
  "integration",
  config.WORKSPACE_PUBLIC_JWKS ? { workspace: JSON.parse(config.WORKSPACE_PUBLIC_JWKS).keys } : {},
);
app.post("/internal/workspaces/:workspaceId/deletions/:deletionId", async (request) => {
  const actor = (await cleanupIdentity.verify(bearer(request.headers.authorization))).actor,
    params = request.params as { workspaceId: string; deletionId: string };
  if (actor.workspaceId !== id.parse(params.workspaceId)) throw new AppError("FORBIDDEN", 403);
  const input = z
    .object({ meetingId: id, sourceVersion: z.number().int().positive() })
    .strict()
    .parse(request.body);
  return purge(
    actor.workspaceId,
    id.parse(params.deletionId),
    input.meetingId,
    input.sourceVersion,
  );
});
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: "0.0.0.0", port: config.PORT });
