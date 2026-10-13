import type { FastifyInstance } from "fastify";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, type Actor } from "@visualsprint/platform";
import type { WorkspacePreparationContext } from "../application/preparation-context.js";
export function preparationContextRoutes(
  app: FastifyInstance,
  service: WorkspacePreparationContext,
  authenticateIntelligence: (token: string) => Promise<Actor>,
) {
  app.post("/internal/workspaces/:workspaceId/preparation-context", async (request, reply) => {
    const actor = await authenticateIntelligence(bearer(request.headers.authorization));
    if (
      actor.operationGrantId ||
      actor.workspaceId !== id.parse((request.params as { workspaceId: string }).workspaceId)
    )
      throw new AppError("FORBIDDEN", 403);
    reply.header("cache-control", "no-store");
    return service.read(actor, request.body);
  });
}
