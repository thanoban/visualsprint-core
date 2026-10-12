import Fastify from "fastify";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, installErrorHandler, type Actor } from "@visualsprint/platform";
import type { CalendarService } from "../application/calendars.js";
export function integrationApp(
  service: CalendarService,
  authenticate: (token: string) => Promise<Actor>,
  configuredProviders: string[],
) {
  const app = Fastify({
    bodyLimit: 24000,
    logger: { redact: ["req.headers.authorization", "req.body", "res.headers"] },
  });
  installErrorHandler(app);
  app.get("/health", async () => ({ status: "ok", service: "integration" }));
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
      const connectionId = (params: unknown) =>
        id.parse((params as { connectionId: string }).connectionId);
      const key = (request: { headers: Record<string, unknown> }) => {
        const value = request.headers["idempotency-key"];
        if (typeof value !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return value;
      };
      routes.get("/providers", () => ({
        providers: configuredProviders,
        automaticCaptureReady: false,
      }));
      routes.get("/", (request) => service.list(actor(request)));
      routes.post("/oauth/start", async (request, reply) =>
        reply.code(201).send(await service.start(actor(request), key(request), request.body)),
      );
      routes.post("/oauth/finish", async (request, reply) =>
        reply.code(202).send(await service.finish(actor(request), request.body)),
      );
      routes.post("/:connectionId/initialize", (request) =>
        service.initialize(actor(request), connectionId(request.params)),
      );
      routes.get("/:connectionId/calendars", (request) =>
        service.calendars(
          actor(request),
          connectionId(request.params),
          (request.query as { cursor?: string }).cursor,
        ),
      );
      routes.get("/:connectionId/occurrences", (request) =>
        service.occurrences(actor(request), connectionId(request.params), request.query),
      );
      routes.post("/:connectionId/sync", async (request, reply) =>
        reply
          .code(202)
          .send(
            await service.synchronize(actor(request), connectionId(request.params), key(request)),
          ),
      );
      routes.post("/:connectionId/meetings", (request) =>
        service.importMeeting(
          actor(request),
          connectionId(request.params),
          key(request),
          request.body,
        ),
      );
      routes.post("/:connectionId/automation", (request) =>
        service.automation(
          actor(request),
          connectionId(request.params),
          key(request),
          request.body,
        ),
      );
      routes.get("/:connectionId/sync", (request) =>
        service.syncStatus(actor(request), connectionId(request.params)),
      );
      routes.get("/:connectionId/stored-occurrences", (request) =>
        service.storedOccurrences(
          actor(request),
          connectionId(request.params),
          (request.query as { after?: string }).after,
        ),
      );
      routes.post("/:connectionId/calendar", (request) =>
        service.select(actor(request), connectionId(request.params), key(request), request.body),
      );
      routes.post("/:connectionId/disconnect", (request) =>
        service.disconnect(
          actor(request),
          connectionId(request.params),
          key(request),
          request.body,
        ),
      );
    },
    { prefix: "/api/v3/workspaces/:workspaceId/connections/calendar" },
  );
  return app;
}
