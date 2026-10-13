import Fastify from "fastify";
import { privateHttpLogger } from "@visualsprint/platform";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, installErrorHandler, type Actor } from "@visualsprint/platform";
import type { ReportingService } from "../application/reporting.js";
export function reportingApp(
  service: ReportingService,
  authenticate: (token: string) => Promise<Actor>,
  cleanup?: (token: string) => Promise<Actor>,
) {
  const app = Fastify({
    bodyLimit: 16000,
    logger: privateHttpLogger,
  });
  installErrorHandler(app);
  app.get("/health", async () => ({ status: "ok", service: "reporting" }));
  app.post("/internal/workspaces/:workspaceId/deletions/:deletionId", async (request) => {
    if (!cleanup) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    const actor = await cleanup(bearer(request.headers.authorization));
    const params = request.params as { workspaceId: string; deletionId: string };
    if (id.parse(params.workspaceId) !== actor.workspaceId) throw new AppError("FORBIDDEN", 403);
    return service.delete(actor.workspaceId, id.parse(params.deletionId), request.body);
  });
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
      const exportId = (params: unknown) => id.parse((params as { exportId: string }).exportId);
      routes.post("/exports", async (request, reply) => {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return reply.code(202).send(await service.create(actor(request), key, request.body));
      });
      routes.get("/exports/:exportId", (request) =>
        service.status(actor(request), exportId(request.params)),
      );
      routes.get("/exports/:exportId/download", async (request, reply) => {
        const artifact = await service.download(actor(request), exportId(request.params));
        return reply
          .header("cache-control", "no-store")
          .header("x-content-type-options", "nosniff")
          .header(
            "content-disposition",
            `attachment; filename="visualsprint-${artifact.id}.${artifact.format === "json" ? "json" : "txt"}"`,
          )
          .type(
            artifact.format === "json"
              ? "application/json; charset=utf-8"
              : "text/plain; charset=utf-8",
          )
          .send(artifact.content);
      });
    },
    { prefix: "/api/v3/workspaces/:workspaceId" },
  );
  return app;
}
