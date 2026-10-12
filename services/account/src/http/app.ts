import Fastify from "fastify";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import {
  AppError,
  bearer,
  installErrorHandler,
  type Actor,
  type Identity,
  type ServiceIdentity,
} from "@visualsprint/platform";
import type { AccountService } from "../application/account.js";
export function accountApp(
  service: AccountService,
  verifyUser: (token: string) => Promise<Identity>,
  serviceIdentity: ServiceIdentity,
) {
  const app = Fastify({
    bodyLimit: 16_000,
    logger: {
      redact: ["req.headers.authorization", "req.headers.x-service-authorization", "req.body"],
    },
  });
  installErrorHandler(app);
  app.get("/health", async () => ({ status: "ok", service: "account" }));
  app.register(
    async (routes) => {
      const identities = new WeakMap<object, Identity>();
      routes.addHook("preHandler", async (request) => {
        const proof = request.headers["x-service-authorization"];
        if (typeof proof !== "string") throw new AppError("UNAUTHENTICATED_SERVICE", 401);
        const hop = await serviceIdentity.verifyIdentity(bearer(proof));
        if (hop.caller !== "gateway") throw new AppError("FORBIDDEN", 403);
        const user = await verifyUser(bearer(request.headers.authorization));
        if (user.subject !== hop.identity.subject || user.sessionId !== hop.identity.sessionId)
          throw new AppError("FORBIDDEN", 403);
        identities.set(request, user);
      });
      const identity = (request: object) => identities.get(request)!;
      routes.get("/me", (request) => service.me(identity(request)));
      routes.post("/workspaces", (request) => {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return service.createWorkspace(identity(request), key, request.body);
      });
      routes.post("/logout", (request) => service.logout(identity(request)));
    },
    { prefix: "/api/v3" },
  );
  app.register(
    async (routes) => {
      const actors = new WeakMap<object, Actor>();
      const callers = new WeakMap<object, string>();
      routes.addHook("preHandler", async (request) => {
        const hop = await serviceIdentity.verify(bearer(request.headers.authorization));
        const workspaceId = id.parse((request.params as { workspaceId: string }).workspaceId);
        if (workspaceId !== hop.actor.workspaceId) throw new AppError("FORBIDDEN", 403);
        actors.set(request, hop.actor);
        callers.set(request, hop.caller);
        const capability = request.routeOptions.url?.split("/").at(-1);
        if (
          hop.actor.operationGrantId &&
          (!["integration", "workspace", "ingest"].includes(hop.caller) ||
            ![
              "membership",
              "reserve",
              "reservation",
              "settle",
              "release",
              "operation",
              "disable-connection",
            ].includes(capability ?? ""))
        )
          throw new AppError("FORBIDDEN", 403);
        const allowed = ["operation", "disable-connection"].includes(capability ?? "")
          ? ["integration"]
          : capability === "membership"
            ? [
                "gateway",
                "workspace",
                "ingest",
                "intelligence",
                "integration",
                "workflow",
                "reporting",
                "notification",
              ]
            : ["reserve", "settle", "release", "reservation"].includes(capability ?? "")
              ? ["ingest"]
              : ["gateway"];
        if (!allowed.includes(hop.caller)) throw new AppError("FORBIDDEN", 403);
      });
      const actor = (request: object) => actors.get(request)!;
      routes.post("/automation/operation", (request) => service.operationContext(actor(request)));
      routes.post("/automation/disable-connection", (request) =>
        service.disableConnectionGrant(actor(request), request.body),
      );
      routes.get("/automation-grants", (request) => service.automationGrants(actor(request)));
      for (const revoke of [false, true])
        routes.post(revoke ? "/automation-grants/revoke" : "/automation-grants", (request) => {
          const key = request.headers["idempotency-key"];
          if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
          return service.changeAutomationGrant(actor(request), key, request.body, revoke);
        });
      routes.post("/usage/reserve", (request) =>
        service.reserveCapture(actor(request), request.body),
      );
      routes.post("/usage/reservation", (request) =>
        service.captureReservation(actor(request), request.body),
      );
      routes.post("/usage/settle", (request) =>
        service.settleCapture(actor(request), request.body),
      );
      routes.post("/usage/release", (request) =>
        service.settleCapture(actor(request), request.body, true),
      );
      routes.get("/directory", (request) => service.directory(actor(request)));
      routes.post("/membership", (request) =>
        service.checkMember(
          actor(request),
          z.object({ userId: id }).strict().parse(request.body).userId,
        ),
      );
      routes.get("/members", (request) => service.members(actor(request)));
      routes.post("/members", (request) => {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return service.changeMember(actor(request), key, request.body);
      });
    },
    { prefix: "/internal/workspaces/:workspaceId" },
  );
  return app;
}
