import type { FastifyInstance } from "fastify";
import { id } from "@visualsprint/contracts";
import { AppError, bearer, type Actor } from "@visualsprint/platform";
import {
  processingContextInput,
  type CaptureProcessingContext,
} from "../application/capture-processing-context.js";
export function captureProcessingContextRoutes(
  app: FastifyInstance,
  service: CaptureProcessingContext,
  authenticateProcessing: (token: string) => Promise<Actor>,
) {
  app.post(
    "/internal/workspaces/:workspaceId/meetings/:meetingId/capture-processing-context",
    async (request, reply) => {
      const actor = await authenticateProcessing(bearer(request.headers.authorization)),
        params = request.params as { workspaceId: string; meetingId: string },
        body = processingContextInput.parse(request.body);
      if (
        actor.workspaceId !== id.parse(params.workspaceId) ||
        body.meetingId !== id.parse(params.meetingId)
      )
        throw new AppError("FORBIDDEN", 403);
      reply.header("cache-control", "no-store");
      return service.read(actor, body);
    },
  );
}
