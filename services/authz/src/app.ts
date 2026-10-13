import Fastify from "fastify";
import { privateHttpLogger } from "@visualsprint/platform";
import { z } from "zod";
import { AppError, bearer, installErrorHandler, type Actor } from "@visualsprint/platform";
import { policyFacts, type OpenFgaPolicy } from "./policy.js";

export function authzApp(policy: OpenFgaPolicy, authenticate: (token: string) => Promise<Actor>) {
  const app = Fastify({
    bodyLimit: 40_000,
    logger: privateHttpLogger,
  });
  installErrorHandler(app);
  app.get("/health", async () => ({ status: "ok", service: "authz" }));
  app.post<{ Params: { workspaceId: string } }>(
    "/internal/workspaces/:workspaceId/check",
    async (request) => {
      const actor = await authenticate(bearer(request.headers.authorization));
      if (actor.workspaceId !== request.params.workspaceId) throw new AppError("FORBIDDEN", 403);
      const input = z
        .object({ checks: z.array(policyFacts).min(1).max(100) })
        .strict()
        .parse(request.body);
      // Bounded parallel batches prevent a listing from exhausting engine connections.
      const allowed: boolean[] = [];
      for (let offset = 0; offset < input.checks.length; offset += 8)
        allowed.push(
          ...(await Promise.all(
            input.checks.slice(offset, offset + 8).map((facts) => policy.check(actor, facts)),
          )),
        );
      return { allowed };
    },
  );
  return app;
}
