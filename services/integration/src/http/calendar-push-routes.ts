import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CalendarPush } from "../application/calendar-push.js";
export function calendarPushRoutes(app: FastifyInstance, push: CalendarPush) {
  app.post("/internal/calendar/webhooks/google", async (request, reply) => {
    await push.google(request.headers);
    return reply.code(204).send();
  });
  app.post(
    "/internal/calendar/webhooks/microsoft",
    {
      onRequest: async (request, reply) => {
        const query = request.query as { validationToken?: unknown };
        if (query.validationToken !== undefined) {
          const token = z.string().min(1).max(2048).parse(query.validationToken);
          await reply
            .header("cache-control", "no-store")
            .header("x-content-type-options", "nosniff")
            .type("text/plain; charset=utf-8")
            .code(200)
            .send(token);
        }
      },
    },
    async (request, reply) => {
      await push.microsoft(request.body);
      return reply.code(202).send();
    },
  );
}
