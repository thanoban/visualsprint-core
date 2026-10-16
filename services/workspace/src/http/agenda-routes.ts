import type { FastifyInstance } from "fastify";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, type Actor } from "@visualsprint/platform";
import type { AgendasService } from "../application/agendas.js";
import type { WorkspaceExportContext } from "../application/export-context.js";
const params = (value: unknown) =>
  value as { workspaceId: string; meetingId: string; agendaId?: string };
function bound(actor: Actor, workspaceId: string) {
  if (
    actor.operationGrantId ||
    actor.sessionId.startsWith("operation:") ||
    actor.workspaceId !== id.parse(workspaceId)
  )
    throw new AppError("FORBIDDEN", 403);
}
export function agendaRoutes(
  app: FastifyInstance,
  service: AgendasService,
  authenticate: (token: string) => Promise<Actor>,
) {
  app.register(
    async (routes) => {
      const actors = new WeakMap<object, Actor>();
      routes.addHook("preHandler", async (request, reply) => {
        const actor = await authenticate(bearer(request.headers.authorization));
        bound(actor, params(request.params).workspaceId);
        actors.set(request, actor);
        reply.header("cache-control", "no-store");
      });
      routes.get("/meetings/:meetingId/agendas", (request) =>
        service.list(actors.get(request)!, id.parse(params(request.params).meetingId)),
      );
      for (const [method, route, operation] of [
        ["POST", "/meetings/:meetingId/agendas", "create"],
        ["PATCH", "/meetings/:meetingId/agendas/:agendaId", "update"],
        ["POST", "/meetings/:meetingId/agendas/:agendaId/delete", "delete"],
      ] as const) {
        routes.route({
          method,
          url: route,
          handler: async (request, reply) => {
            const p = params(request.params),
              key = request.headers["idempotency-key"];
            if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
            const result = await service.mutate(
              actors.get(request)!,
              id.parse(p.meetingId),
              key,
              operation,
              request.body,
              p.agendaId,
            );
            return reply.code(operation === "create" ? 201 : 200).send(result);
          },
        });
      }
    },
    { prefix: "/api/v3/workspaces/:workspaceId" },
  );
}
export function exportContextRoutes(
  app: FastifyInstance,
  service: WorkspaceExportContext,
  authenticateReporting: (token: string) => Promise<Actor>,
) {
  app.get(
    "/internal/workspaces/:workspaceId/meetings/:meetingId/export-context",
    async (request, reply) => {
      const actor = await authenticateReporting(bearer(request.headers.authorization)),
        p = params(request.params);
      bound(actor, p.workspaceId);
      reply.header("cache-control", "no-store");
      return service.read(actor, id.parse(p.meetingId));
    },
  );
}
