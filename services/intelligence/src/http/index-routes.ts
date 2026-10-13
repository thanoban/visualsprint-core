import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, type Actor } from "@visualsprint/platform";
import type { EvidenceIndexing } from "../application/indexing.js";
import { scope } from "../application/schemas.js";
export function registerIndexRoutes(
  app: FastifyInstance,
  service: EvidenceIndexing | undefined,
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
      routes.post("/indexes", async (request, reply) => {
        if (!service) throw new AppError("RETRIEVAL_DISABLED", 503);
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        const input = z.object({ scope }).strict().parse(request.body);
        return reply.code(202).send(await service.request(actors.get(request)!, key, input.scope));
      });
      routes.get("/indexes/:jobId", (request) => {
        if (!service) throw new AppError("RETRIEVAL_DISABLED", 503);
        return service.status(
          actors.get(request)!,
          id.parse((request.params as { jobId: string }).jobId),
        );
      });
      routes.post("/retrieval", (request) => {
        if (!service) throw new AppError("RETRIEVAL_DISABLED", 503);
        const input = z
          .object({ scope, query: z.string().min(1).max(6000) })
          .strict()
          .parse(request.body);
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return service.retrieve(actors.get(request)!, input.scope, input.query, key);
      });
    },
    { prefix: "/api/v3/workspaces/:workspaceId/intelligence" },
  );
}
