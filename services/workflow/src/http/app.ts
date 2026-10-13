import Fastify from "fastify";
import { privateHttpLogger } from "@visualsprint/platform";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, installErrorHandler, type Actor } from "@visualsprint/platform";
import type { WorkflowService } from "../application/workflow.js";
import type { Operation } from "../domain/action.js";
const operationView = (operation: Operation) => ({
  id: operation.id,
  actionId: operation.actionId,
  state: operation.state,
  externalId: operation.externalId,
  errorCode: operation.errorCode,
  version: operation.version,
});
export function workflowApp(
  service: WorkflowService,
  authenticate: (token: string) => Promise<Actor>,
  authenticateIntegration?: (token: string) => Promise<Actor>,
  authenticateDeletion?: (token: string) => Promise<Actor>,
) {
  const app = Fastify({
    bodyLimit: 32000,
    logger: privateHttpLogger,
  });
  installErrorHandler(app);
  app.get("/health", async () => ({ status: "ok", service: "workflow" }));
  app.get(
    "/internal/workspaces/:workspaceId/operations/:operationId/reference-context",
    async (request) => {
      if (!authenticateIntegration) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
      const actor = await authenticateIntegration(bearer(request.headers.authorization));
      const params = request.params as { workspaceId: string; operationId: string };
      if (id.parse(params.workspaceId) !== actor.workspaceId || actor.operationGrantId)
        throw new AppError("FORBIDDEN", 403);
      return service.referenceContext(actor, id.parse(params.operationId));
    },
  );
  app.post("/internal/workspaces/:workspaceId/deletions/:deletionId", async (request) => {
    if (!authenticateDeletion) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    const actor = await authenticateDeletion(bearer(request.headers.authorization));
    const params = request.params as { workspaceId: string; deletionId: string };
    if (id.parse(params.workspaceId) !== actor.workspaceId) throw new AppError("FORBIDDEN", 403);
    return service.deleteMeeting(actor, id.parse(params.deletionId), request.body);
  });
  app.get("/internal/workspaces/:workspaceId/operations/:operationId/approval", async (request) => {
    if (!authenticateIntegration) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    const actor = await authenticateIntegration(bearer(request.headers.authorization));
    const params = request.params as { workspaceId: string; operationId: string };
    if (id.parse(params.workspaceId) !== actor.workspaceId || actor.operationGrantId)
      throw new AppError("FORBIDDEN", 403);
    return service.proof(actor, id.parse(params.operationId));
  });
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
      const actor = (request: object) => actors.get(request)!;
      const key = (request: { headers: Record<string, unknown> }) => {
        const value = request.headers["idempotency-key"];
        if (typeof value !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return value;
      };
      const actionId = (params: unknown) => id.parse((params as { actionId: string }).actionId);
      routes.get("/actions", (request) => {
        const value = (request.query as { meetingId?: string }).meetingId;
        return service.list(actor(request), value ? id.parse(value) : undefined);
      });
      routes.post("/actions", async (request, reply) =>
        reply.code(201).send(await service.propose(actor(request), key(request), request.body)),
      );
      routes.get("/actions/:actionId", (request) =>
        service.read(actor(request), actionId(request.params)),
      );
      routes.get("/actions/:actionId/operations", async (request) =>
        (await service.operations(actor(request), actionId(request.params))).map(operationView),
      );
      routes.patch("/actions/:actionId", (request) =>
        service.edit(actor(request), actionId(request.params), key(request), request.body),
      );
      routes.post("/actions/:actionId/approve", (request) =>
        service.approve(actor(request), actionId(request.params), key(request), request.body),
      );
      routes.post("/actions/:actionId/revoke", (request) =>
        service.revoke(actor(request), actionId(request.params), key(request), request.body),
      );
      routes.post("/actions/:actionId/execute", async (request, reply) =>
        reply
          .code(202)
          .send(
            operationView(
              await service.execute(
                actor(request),
                actionId(request.params),
                key(request),
                request.body,
              ),
            ),
          ),
      );
      routes.get("/operations/:operationId", async (request) =>
        operationView(
          await service.status(
            actor(request),
            id.parse((request.params as { operationId: string }).operationId),
          ),
        ),
      );
    },
    { prefix: "/api/v3/workspaces/:workspaceId" },
  );
  return app;
}
