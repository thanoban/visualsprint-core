import Fastify from "fastify";
import { eventEnvelope, id } from "@visualsprint/contracts";
import {
  AppError,
  bearer,
  installErrorHandler,
  privateHttpLogger,
  type Actor,
} from "@visualsprint/platform";
import { NotificationService, authorizedEvent } from "../application/notification.js";
export function notificationApp(
  service: NotificationService,
  authenticate: (token: string) => Promise<Actor>,
  authenticateEvent?: (token: string) => Promise<{ caller: string; actor: Actor }>,
  authenticateDeletion?: (token: string) => Promise<Actor>,
) {
  const app = Fastify({
    bodyLimit: 32000,
    logger: privateHttpLogger,
  });
  installErrorHandler(app);
  app.get("/health", async () => ({ status: "ok", service: "notification" }));
  app.post("/internal/workspaces/:workspaceId/events", async (request, reply) => {
    if (!authenticateEvent) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    const auth = await authenticateEvent(bearer(request.headers.authorization));
    const event = eventEnvelope.parse(request.body);
    if (
      event.workspaceId !== id.parse((request.params as { workspaceId: string }).workspaceId) ||
      event.workspaceId !== auth.actor.workspaceId ||
      event.actorId !== auth.actor.actorId ||
      !authorizedEvent(auth.caller, event)
    )
      throw new AppError("FORBIDDEN", 403);
    await service.receive(event);
    return reply.code(204).send();
  });
  app.post("/internal/workspaces/:workspaceId/deletions/:deletionId", async (request) => {
    if (!authenticateDeletion) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    const actor = await authenticateDeletion(bearer(request.headers.authorization));
    const params = request.params as { workspaceId: string; deletionId: string };
    if (id.parse(params.workspaceId) !== actor.workspaceId) throw new AppError("FORBIDDEN", 403);
    return service.deleteMeeting(actor, id.parse(params.deletionId), request.body);
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
      routes.post("/realtime/negotiate", async (request, reply) => {
        zEmpty(request.body, request.query);
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        return service.negotiate(actor(request));
      });
      const key = (request: { headers: Record<string, unknown> }) => {
        const value = request.headers["idempotency-key"];
        if (typeof value !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return value;
      };
      routes.get("/notification-preferences", (request) => service.preferences(actor(request)));
      routes.post("/notification-preferences", (request) =>
        service.savePreferences(actor(request), key(request), request.body),
      );
      routes.get("/notifications", (request) =>
        service.list(actor(request), (request.query as { after?: string }).after),
      );
      routes.post("/notifications/:notificationId/read", (request) => {
        key(request);
        return service.markRead(
          actor(request),
          id.parse((request.params as { notificationId: string }).notificationId),
          request.body,
        );
      });
    },
    { prefix: "/api/v3/workspaces/:workspaceId" },
  );
  return app;
}
function zEmpty(body: unknown, query: unknown) {
  if (
    (body !== undefined &&
      body !== null &&
      (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)) ||
    (query && Object.keys(query).length)
  )
    throw new AppError("INVALID_REALTIME_REQUEST", 400);
}
