import type { FastifyInstance } from "fastify";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, type Actor } from "@visualsprint/platform";
import type { AuthzDeletionService } from "./deletion-service.js";
export function authzDeletionRoutes(
  app: FastifyInstance,
  service: AuthzDeletionService,
  authenticateWorkspace: (token: string) => Promise<Actor>,
) {
  app.post("/internal/workspaces/:workspaceId/deletions/:deletionId", async (request) => {
    const actor = await authenticateWorkspace(bearer(request.headers.authorization)),
      params = request.params as { workspaceId: string; deletionId: string };
    if (id.parse(params.workspaceId) !== actor.workspaceId) throw new AppError("FORBIDDEN", 403);
    return service.delete(actor, id.parse(params.deletionId), request.body);
  });
}
