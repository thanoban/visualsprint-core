import Fastify from "fastify";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, installErrorHandler, type Actor } from "@visualsprint/platform";
import type { IntelligenceService } from "../application/intelligence.js";

export function intelligenceApp(
  service: IntelligenceService,
  authenticate: (token: string) => Promise<Actor>,
  authenticateDeletion?: (token: string) => Promise<Actor>,
  authenticateRead?: (token:string)=>Promise<Actor>,
) {
  const app = Fastify({
    bodyLimit: 48_000,
    logger: { redact: ["req.headers.authorization", "req.body", "res.headers"] },
  });
  installErrorHandler(app);
  app.get("/health", async () => ({ status: "ok", service: "intelligence" }));
  app.post("/internal/workspaces/:workspaceId/deletions/:deletionId", async (request) => {
    if (!authenticateDeletion) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    const actor = await authenticateDeletion(bearer(request.headers.authorization));
    const workspaceId = id.parse((request.params as { workspaceId: string }).workspaceId);
    if (actor.workspaceId !== workspaceId) throw new AppError("FORBIDDEN", 403);
    const deletionId = id.parse((request.params as { deletionId: string }).deletionId);
    const input = z
      .object({ meetingId: id, sourceVersion: z.number().int().positive() })
      .strict()
      .parse(request.body);
    await service.purgeMeeting(workspaceId, input.meetingId, deletionId, input.sourceVersion);
    return {
      deletionId,
      meetingId: input.meetingId,
      participant: "intelligence",
      state: "complete",
    };
  });
  app.register(
    async (routes) => {
      const actors = new WeakMap<object, Actor>();
      routes.addHook("preHandler", async (request) => {
      const actor = await (request.method==="GET"&&authenticateRead?authenticateRead:authenticate)(bearer(request.headers.authorization));
        if (
          actor.operationGrantId ||
          id.parse((request.params as { workspaceId: string }).workspaceId) !== actor.workspaceId
        )
          throw new AppError("FORBIDDEN", 403);
        actors.set(request, actor);
      });
      const actor = (request: object) => actors.get(request)!;
      const key = (request: { headers: Record<string, unknown> }) => {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return key;
      };
      const threadId = (params: unknown) => id.parse((params as { threadId: string }).threadId);
      routes.post("/summaries", async (request, reply) =>
        reply.code(202).send(await service.summary(actor(request), key(request), request.body)),
      );
      routes.get("/meetings/:meetingId/summaries", (request) =>
        service.summaries(
          actor(request),
          id.parse((request.params as { meetingId: string }).meetingId),
        ),
      );
      routes.get("/jobs/:jobId", (request) =>
        service.job(actor(request), id.parse((request.params as { jobId: string }).jobId)),
      );
      routes.post("/chats", async (request, reply) =>
        reply
          .code(201)
          .send(await service.createThread(actor(request), key(request), request.body)),
      );
      routes.get("/chats", (request) => service.threads(actor(request)));
      routes.get("/chats/:threadId/messages", (request) =>
        service.messages(actor(request), threadId(request.params)),
      );
      routes.post("/chats/:threadId/messages", async (request, reply) =>
        reply
          .code(202)
          .send(
            await service.message(
              actor(request),
              threadId(request.params),
              key(request),
              request.body,
            ),
          ),
      );
    },
    { prefix: "/api/v3/workspaces/:workspaceId/intelligence" },
  );
  return app;
}
