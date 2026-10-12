import Fastify from "fastify";
import { createHash } from "node:crypto";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, installErrorHandler, type Actor } from "@visualsprint/platform";
import type { CaptureService } from "../application/capture-service.js";
import { RecallSignatures } from "../infrastructure/webhook-signature.js";
import { providerEvent } from "../infrastructure/provider-events.js";

export function ingestApp(
  service: CaptureService,
  authenticate: (token: string) => Promise<Actor>,
  signatures: RecallSignatures,
) {
  const app = Fastify({
    bodyLimit: 1_000_000,
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.webhook-signature",
        "req.body",
        "res.headers",
      ],
    },
  });
  installErrorHandler(app);
  app.get("/health", async () => ({ status: "ok", service: "ingest" }));
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
        const actor = await authenticate(bearer(request.headers.authorization));
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
      routes.get("/captures/:requestId", (request) =>
        service.status(actor(request), requestId(request.params)),
      );
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
