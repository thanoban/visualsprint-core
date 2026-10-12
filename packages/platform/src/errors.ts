import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    const frameworkStatus = typeof error === "object" && error !== null && "statusCode" in error
      && typeof error.statusCode === "number" && [400,413,415,429].includes(error.statusCode) ? error.statusCode : undefined;
    const status = error instanceof AppError ? error.status : error instanceof ZodError ? 400 : frameworkStatus ?? 503;
    const code = error instanceof AppError ? error.code : error instanceof ZodError || frameworkStatus ? "INVALID_REQUEST" : "SERVICE_UNAVAILABLE";
    // Do not serialize SQL, tokens, request bodies or upstream exception messages.
    request.log.warn({ code, requestId: request.id }, "request failed");
    void reply.code(status).send({ code, requestId: request.id });
  });
}
