import type { FastifyInstance } from "fastify";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, type Actor } from "@visualsprint/platform";
import {
  proofFromCaptureEvent,
  type DurableCaptureExtraction,
} from "../application/capture-extraction.js";

export function registerCaptureExtractionRoutes(
  app: FastifyInstance,
  extraction: DurableCaptureExtraction | undefined,
  authenticate: (token: string) => Promise<Actor>,
  authenticateEvent?: (token: string) => Promise<Actor>,
) {
  const feature = () => {
    if (!extraction) throw new AppError("CAPTURE_EXTRACTION_NOT_CONFIGURED", 503);
    return extraction;
  };
  app.post(
    "/internal/workspaces/:workspaceId/capture-processing/events",
    async (request, reply) => {
      const service = feature();
      if (!authenticateEvent) throw new AppError("UNAUTHENTICATED_SERVICE", 401);
      const actor = await authenticateEvent(bearer(request.headers.authorization));
      const { event, proof } = proofFromCaptureEvent(request.body);
      if (
        actor.workspaceId !== id.parse((request.params as { workspaceId: string }).workspaceId) ||
        event.workspaceId !== actor.workspaceId ||
        event.actorId !== actor.actorId ||
        (actor.operationGrantId && actor.operationGrantId !== proof.consentId)
      )
        throw new AppError("FORBIDDEN", 403);
      return reply.code(202).send(await service.consume(event));
    },
  );
  app.get(
    "/api/v3/workspaces/:workspaceId/intelligence/meetings/:meetingId/capture-extractions",
    async (request) => {
      const actor = await authenticate(bearer(request.headers.authorization)),
        params = request.params as { workspaceId: string; meetingId: string };
      if (actor.workspaceId !== id.parse(params.workspaceId)) throw new AppError("FORBIDDEN", 403);
      return feature().list(actor, id.parse(params.meetingId));
    },
  );
  app.get(
    "/api/v3/workspaces/:workspaceId/intelligence/capture-extractions/:jobId",
    async (request) => {
      const actor = await authenticate(bearer(request.headers.authorization)),
        params = request.params as { workspaceId: string; jobId: string };
      if (actor.workspaceId !== id.parse(params.workspaceId)) throw new AppError("FORBIDDEN", 403);
      return feature().load(actor, id.parse(params.jobId));
    },
  );
}
