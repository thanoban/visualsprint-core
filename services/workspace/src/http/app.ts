import Fastify from "fastify";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, installErrorHandler, type Actor } from "@visualsprint/platform";
import type { WorkspaceService } from "../application/workspace.js";

export function workspaceApp(
  service: WorkspaceService,
  authenticate: (token: string) => Promise<Actor>,
  authenticateInternal?: (token: string) => Promise<Actor>,
) {
  const app = Fastify({
    bodyLimit: 48_000,
    logger: { redact: ["req.headers.authorization", "req.body", "res.headers"] },
  });
  installErrorHandler(app);
  const actors = new WeakMap<object, Actor>();
  app.get("/health", async () => ({ status: "ok", service: "workspace" }));
  app.register(
    async (routes) => {
      const actorFor = async (request: {
        headers: { authorization?: string | undefined };
        params: unknown;
      }) => {
        if (!authenticateInternal) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
        const actor = await authenticateInternal(bearer(request.headers.authorization));
        const params = request.params as { workspaceId: string; meetingId: string };
        if (id.parse(params.workspaceId) !== actor.workspaceId)
          throw new AppError("FORBIDDEN", 403);
        return { actor, meetingId: id.parse(params.meetingId) };
      };
      routes.get("/meetings/:meetingId/capture-context", async (request) => {
        const { actor, meetingId } = await actorFor(request);
        return service.captureContext(actor, meetingId);
      });
      routes.get("/meetings/:meetingId/evidence-context", async (request) => {
        const { actor, meetingId } = await actorFor(request);
        return service.evidenceContext(actor, meetingId);
      });
      routes.get("/meetings/:meetingId/manage-context", async (request) => {
        const { actor, meetingId } = await actorFor(request);
        return service.manageContext(actor, meetingId);
      });
    },
    { prefix: "/internal/workspaces/:workspaceId" },
  );
  app.register(
    async (routes) => {
      routes.addHook("preHandler", async (request) => {
        const actor = await authenticate(bearer(request.headers.authorization));
        const workspaceId = id.parse((request.params as { workspaceId: string }).workspaceId);
        if (workspaceId !== actor.workspaceId) throw new AppError("FORBIDDEN", 403);
        actors.set(request, actor);
      });
      const actor = (request: object) => actors.get(request)!;
      const key = (request: { headers: Record<string, unknown> }) => {
        const value = request.headers["idempotency-key"];
        if (typeof value !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return value;
      };
      const meetingId = (params: unknown) => id.parse((params as { meetingId: string }).meetingId);
      routes.get("/customers", (request) => service.customers(actor(request)));
      routes.post("/customers", async (request, reply) =>
        reply.code(201).send(await service.addCustomer(actor(request), key(request), request.body)),
      );
      routes.get("/projects", (request) => service.projects(actor(request)));
      routes.post("/projects", async (request, reply) =>
        reply.code(201).send(await service.addProject(actor(request), key(request), request.body)),
      );
      routes.get("/meetings", (request) => {
        const query = request.query as { projectId?: string };
        return service.meetings(actor(request), query.projectId);
      });
      routes.post("/meetings", async (request, reply) =>
        reply.code(201).send(await service.addMeeting(actor(request), key(request), request.body)),
      );
      routes.get("/meetings/:meetingId", (request) =>
        service.meeting(actor(request), meetingId(request.params)),
      );
      routes.patch("/meetings/:meetingId", (request) =>
        service.edit(actor(request), meetingId(request.params), key(request), request.body),
      );
      routes.post("/meetings/:meetingId/assignments", (request) =>
        service.assign(actor(request), meetingId(request.params), key(request), request.body),
      );
      routes.post("/meetings/:meetingId/shares", (request) =>
        service.share(actor(request), meetingId(request.params), key(request), request.body),
      );
      routes.delete("/meetings/:meetingId/shares", (request) =>
        service.share(actor(request), meetingId(request.params), key(request), request.body, true),
      );
    },
    { prefix: "/api/v3/workspaces/:workspaceId" },
  );
  return app;
}
