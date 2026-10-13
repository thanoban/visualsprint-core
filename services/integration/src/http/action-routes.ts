import type { FastifyInstance } from "fastify";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, type Actor } from "@visualsprint/platform";
import type { ActionExecutions } from "../application/action-executions.js";
export function actionRoutes(
  app: FastifyInstance,
  service: ActionExecutions,
  authenticateUser: (token: string) => Promise<Actor>,
  authenticateWorkflow: (token: string) => Promise<Actor>,
) {
  app.register(
    async (routes) => {
      const actors = new WeakMap<object, Actor>();
      routes.addHook("preHandler", async (request) => {
        const actor = await authenticateUser(bearer(request.headers.authorization));
        if (
          actor.operationGrantId ||
          actor.workspaceId !== id.parse((request.params as { workspaceId: string }).workspaceId)
        )
          throw new AppError("FORBIDDEN", 403);
        actors.set(request, actor);
      });
      const actor = (req: object) => actors.get(req)!;
      routes.get("/action-connections", (request) => service.list(actor(request)));
      routes.post("/action-connections", async (request, reply) => {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return reply.code(201).send(await service.configure(actor(request), key, request.body));
      });
      routes.delete("/action-connections/:connectionId", (request) =>
        service.disconnect(
          actor(request),
          id.parse((request.params as { connectionId: string }).connectionId),
          request.body,
        ),
      );
      routes.post("/action-executions/:operationId/reference", (request) =>
        service.reference(
          actor(request),
          id.parse((request.params as { operationId: string }).operationId),
          request.body,
        ),
      );
      routes.get("/action-executions/:operationId/task-status", (request) =>
        service.taskStatus(
          actor(request),
          id.parse((request.params as { operationId: string }).operationId),
        ),
      );
    },
    { prefix: "/api/v3/workspaces/:workspaceId" },
  );
  app.register(
    async (routes) => {
      const actors = new WeakMap<object, Actor>();
      routes.addHook("preHandler", async (request) => {
        const actor = await authenticateWorkflow(bearer(request.headers.authorization));
        if (
          actor.operationGrantId ||
          actor.workspaceId !== id.parse((request.params as { workspaceId: string }).workspaceId)
        )
          throw new AppError("FORBIDDEN", 403);
        actors.set(request, actor);
      });
      routes.post("/action-executions", (request) =>
        service.execute(actors.get(request)!, request.body),
      );
      routes.post("/action-executions/:operationId/reconcile", (request) =>
        service.reconcile(
          actors.get(request)!,
          id.parse((request.params as { operationId: string }).operationId),
          request.body,
        ),
      );
    },
    { prefix: "/internal/workspaces/:workspaceId" },
  );
}
