import type { FastifyInstance } from "fastify";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, type Actor } from "@visualsprint/platform";
import type { CommitmentsService, AcceptedKind } from "../application/commitments.js";
export function commitmentRoutes(
  app: FastifyInstance,
  service: CommitmentsService,
  authenticate: (token: string) => Promise<Actor>,
  authenticateWorkflow?: (token: string) => Promise<Actor>,
) {
  app.register(
    async (routes) => {
      const actors = new WeakMap<object, Actor>();
      routes.addHook("preHandler", async (request) => {
        const actor = await authenticate(bearer(request.headers.authorization));
        if (
          actor.operationGrantId ||
          actor.workspaceId !== id.parse((request.params as { workspaceId: string }).workspaceId)
        )
          throw new AppError("FORBIDDEN", 403);
        actors.set(request, actor);
      });
      const actor = (request: object) => actors.get(request)!;
      const key = (headers: Record<string, unknown>) => {
        const k = headers["idempotency-key"];
        if (typeof k !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return k;
      };
      for (const [route, kind] of [
        ["decisions", "decision"],
        ["commitments", "commitment"],
      ] as [string, AcceptedKind][]) {
        routes.get(`/${route}`, (request) => {
          const query = request.query as { scopeKind?: string; scopeId?: string };
          return service.list(actor(request), kind, {
            kind: query.scopeKind ?? "workspace",
            id: query.scopeId ?? null,
          });
        });
        routes.post(`/${route}`, async (request, reply) =>
          reply
            .code(201)
            .send(await service.accept(actor(request), key(request.headers), kind, request.body)),
        );
        routes.get(`/${route}/:itemId`, (request) =>
          service.read(
            actor(request),
            id.parse((request.params as { itemId: string }).itemId),
            kind,
          ),
        );
        routes.patch(`/${route}/:itemId`, (request) =>
          service.correct(
            actor(request),
            id.parse((request.params as { itemId: string }).itemId),
            kind,
            key(request.headers),
            request.body,
          ),
        );
        routes.post(`/${route}/:itemId/status`, (request) =>
          service.status(
            actor(request),
            id.parse((request.params as { itemId: string }).itemId),
            kind,
            key(request.headers),
            request.body,
          ),
        );
      }
    },
    { prefix: "/api/v3/workspaces/:workspaceId" },
  );
  if (authenticateWorkflow)
    app.get("/internal/workspaces/:workspaceId/commitments/:itemId/source", async (request) => {
      const actor = await authenticateWorkflow(bearer(request.headers.authorization)),
        params = request.params as { workspaceId: string; itemId: string };
      if (actor.operationGrantId || actor.workspaceId !== id.parse(params.workspaceId))
        throw new AppError("FORBIDDEN", 403);
      const item = await service.read(actor, id.parse(params.itemId), "commitment");
      return {
        id: item.id,
        meetingId: item.meetingId,
        version: item.version,
        title: item.title,
        text: item.text,
        ownerId: item.ownerId,
        dueDate: item.dueDate,
        state: item.state,
        evidenceStatus: item.evidenceStatus,
        humanReviewed: true,
      };
    });
}
