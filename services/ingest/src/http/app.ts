import Fastify from "fastify";
import { privateHttpLogger } from "@visualsprint/platform";
import { createHash } from "node:crypto";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, installErrorHandler, type Actor } from "@visualsprint/platform";
import type { CaptureService } from "../application/capture-service.js";
import { RecallSignatures } from "../infrastructure/webhook-signature.js";
import { providerEvent } from "../infrastructure/provider-events.js";
import type { CaptureProcessingService } from "../application/capture-processing.js";

export function ingestApp(
  service: CaptureService,
  authenticate: (token: string) => Promise<Actor>,
  signatures: RecallSignatures,
  authenticateCalendar?: (token: string) => Promise<Actor>,
  authenticateRead?: (token: string) => Promise<Actor>,
  authenticateDeletion?: (token: string) => Promise<Actor>,
  processing?: {
    service: CaptureProcessingService;
    authenticateOwner: (token: string) => Promise<Actor>;
    authenticateEvidence: (token: string) => Promise<Actor>;
  },
) {
  const app = Fastify({
    bodyLimit: 1_000_000,
    logger: privateHttpLogger,
  });
  installErrorHandler(app);
  app.get("/health", async () => ({ status: "ok", service: "ingest" }));
  app.post(
    "/internal/workspaces/:workspaceId/captures/:captureId/processing-owner-context",
    async (request) => {
      if (!processing) throw new AppError("CAPTURE_PROCESSING_NOT_CONFIGURED", 503);
      const actor = await processing.authenticateOwner(bearer(request.headers.authorization)),
        params = request.params as { workspaceId: string; captureId: string };
      if (id.parse(params.workspaceId) !== actor.workspaceId) throw new AppError("FORBIDDEN", 403);
      return processing.service.ownerContext(actor, id.parse(params.captureId));
    },
  );
  app.post(
    "/internal/workspaces/:workspaceId/captures/:captureId/processing-evidence",
    async (request) => {
      if (!processing) throw new AppError("CAPTURE_PROCESSING_NOT_CONFIGURED", 503);
      const actor = await processing.authenticateEvidence(bearer(request.headers.authorization)),
        params = request.params as { workspaceId: string; captureId: string };
      if (id.parse(params.workspaceId) !== actor.workspaceId) throw new AppError("FORBIDDEN", 403);
      return processing.service.evidence(actor, id.parse(params.captureId), request.body);
    },
  );
  app.post("/internal/workspaces/:workspaceId/evidence-batch", async (request) => {
    if (!authenticateDeletion) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    const actor = await authenticateDeletion(bearer(request.headers.authorization));
    if (id.parse((request.params as { workspaceId: string }).workspaceId) !== actor.workspaceId)
      throw new AppError("FORBIDDEN", 403);
    return service.evidenceBatch(actor, request.body);
  });
  app.post("/internal/workspaces/:workspaceId/deletions/:deletionId", async (request) => {
    if (!authenticateDeletion) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    const actor = await authenticateDeletion(bearer(request.headers.authorization));
    const params = request.params as { workspaceId: string; deletionId: string };
    if (id.parse(params.workspaceId) !== actor.workspaceId) throw new AppError("FORBIDDEN", 403);
    return service.deleteMeeting(actor.workspaceId, id.parse(params.deletionId), request.body);
  });
  app.post("/internal/workspaces/:workspaceId/calendar-commands", async (request) => {
    if (!authenticateCalendar) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    const actor = await authenticateCalendar(bearer(request.headers.authorization));
    if (
      !actor.operationGrantId ||
      id.parse((request.params as { workspaceId: string }).workspaceId) !== actor.workspaceId
    )
      throw new AppError("FORBIDDEN", 403);
    return service.calendarCommand(actor, request.body);
  });
  app.post("/internal/workspaces/:workspaceId/calendar-captures", async (request, reply) => {
    if (!authenticateCalendar) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
    const actor = await authenticateCalendar(bearer(request.headers.authorization));
    if (
      !actor.operationGrantId ||
      id.parse((request.params as { workspaceId: string }).workspaceId) !== actor.workspaceId
    )
      throw new AppError("FORBIDDEN", 403);
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
    if (!key.startsWith(`calendar:${actor.operationGrantId}:`))
      throw new AppError("FORBIDDEN", 403);
    return reply.code(202).send(await service.request(actor, key, request.body));
  });
  app.register(
    async (routes) => {
      routes.removeContentTypeParser("application/json");
      routes.addContentTypeParser(
        "application/json",
        { parseAs: "buffer" },
        (_request, body, done) => done(null, body),
      );
      routes.post("/recall", async (request, reply) => {
        const raw = request.body as Buffer;
        let messageId: string;
        try {
          messageId = signatures.verify(request.headers, raw);
        } catch {
          throw new AppError("INVALID_WEBHOOK_SIGNATURE", 401);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new AppError("INVALID_WEBHOOK_PAYLOAD", 400);
        }
        await service.receive(
          "recall",
          messageId,
          createHash("sha256").update(raw).digest("hex"),
          providerEvent(payload),
        );
        return reply.code(204).send();
      });
    },
    { prefix: "/webhooks/v3" },
  );
  app.register(
    async (routes) => {
      const actors = new WeakMap<object, Actor>();
      routes.addHook("preHandler", async (request) => {
        const actor = await (
          request.method === "GET" && authenticateRead ? authenticateRead : authenticate
        )(bearer(request.headers.authorization));
        if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
        if (id.parse((request.params as { workspaceId: string }).workspaceId) !== actor.workspaceId)
          throw new AppError("FORBIDDEN", 403);
        actors.set(request, actor);
      });
      const actor = (request: object) => actors.get(request)!;
      const requestId = (params: unknown) => id.parse((params as { requestId: string }).requestId);
      routes.post("/captures", async (request, reply) => {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return reply.code(202).send(await service.request(actor(request), key, request.body));
      });
      routes.get("/captures/:requestId", async (request) => {
        const result = await service.status(actor(request), requestId(request.params));
        return {
          ...result,
          processing:
            processing && result.ownerId === actor(request).actorId
              ? await processing.service.status(actor(request), result.id)
              : null,
        };
      });
      routes.post("/captures/:requestId/processing-consent", async (request, reply) => {
        if (!processing) throw new AppError("CAPTURE_PROCESSING_NOT_CONFIGURED", 503);
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        await processing.service.consent(
          actor(request),
          requestId(request.params),
          key,
          request.body,
        );
        return reply
          .code(202)
          .send(await processing.service.status(actor(request), requestId(request.params)));
      });
      routes.post("/captures/:requestId/processing-consent/withdraw", async (request, reply) => {
        if (!processing) throw new AppError("CAPTURE_PROCESSING_NOT_CONFIGURED", 503);
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        await processing.service.withdraw(
          actor(request),
          requestId(request.params),
          key,
          request.body,
        );
        return reply
          .code(202)
          .send(await processing.service.status(actor(request), requestId(request.params)));
      });
      routes.post("/captures/:requestId/stop", (request) =>
        service.stop(actor(request), requestId(request.params)),
      );
      routes.get("/captures/:requestId/transcript", (request) =>
        service.transcript(
          actor(request),
          requestId(request.params),
          (request.query as { cursor?: string }).cursor,
        ),
      );
      routes.get("/meetings/:meetingId/captures", (request) =>
        service.list(actor(request), id.parse((request.params as { meetingId: string }).meetingId)),
      );
    },
    { prefix: "/api/v3/workspaces/:workspaceId" },
  );
  return app;
}
