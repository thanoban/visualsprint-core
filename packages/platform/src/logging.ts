import type { FastifyLoggerOptions } from "fastify";

// Request URLs can contain OAuth codes, user questions and meeting passcodes.
// Keep correlated transport metadata, never raw URLs, bodies or exception text.
export const privateHttpLogger: FastifyLoggerOptions & { redact: string[] } = {
  redact: ["req.headers", "req.body", "res.headers"],
  serializers: {
    req(request) {
      return { id: request.id, method: request.method };
    },
    res(response) {
      return { statusCode: response.statusCode };
    },
    err() {
      return { type: "Error", message: "Redacted exception", stack: "" };
    },
  },
};
