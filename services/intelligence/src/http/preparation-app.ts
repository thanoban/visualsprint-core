import Fastify, { type FastifyInstance } from "fastify";
import { id } from "@visualsprint/contracts";
import {
  AppError,
  bearer,
  installErrorHandler,
  privateHttpLogger,
  type Actor,
} from "@visualsprint/platform";
import type { DurablePreparation } from "../application/preparation-jobs.js";
export function preparationApp(
  service: DurablePreparation,
  authenticate: (token: string) => Promise<Actor>,
) {
  const app = Fastify({
    bodyLimit: 48_000,
    logger: privateHttpLogger,
  });
  installErrorHandler(app);
  registerPreparationRoutes(app, service, authenticate);
  return app;
}
export function registerPreparationRoutes(
  app: FastifyInstance,
  service: DurablePreparation | undefined,
  authenticate: (token: string) => Promise<Actor>,
) {
  app.register(
    async (routes) => {
      const actors = new WeakMap<object, Actor>();
      routes.addHook("preHandler", async (request) => {
        const actor = await authenticate(bearer(request.headers.authorization));
        if (
          actor.operationGrantId ||
          id.parse((request.params as { workspaceId: string }).workspaceId) !== actor.workspaceId
        )
          throw new AppError("FORBIDDEN", 403);
        actors.set(request, actor);
      });
      routes.post("/preparations", async (request, reply) => {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        if (!service) throw new AppError("PREPARATION_DISABLED", 503);
        return reply.code(202).send(await service.request(actors.get(request)!, key, request.body));
      });
      routes.get("/preparations/:jobId", (request) => {
        if (!service) throw new AppError("PREPARATION_DISABLED", 503);
        return service.status(
          actors.get(request)!,
          id.parse((request.params as { jobId: string }).jobId),
        );
      });
    },
    { prefix: "/api/v3/workspaces/:workspaceId/intelligence" },
  );
}
