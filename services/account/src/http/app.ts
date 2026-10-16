import Fastify from "fastify";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import {
  AppError,
  bearer,
  installErrorHandler,
  privateHttpLogger,
  type Actor,
  type Identity,
  type ServiceIdentity,
} from "@visualsprint/platform";
import type { AccountService } from "../application/account.js";
import type { ModelUsageService } from "../application/model-usage.js";
import type { CaptureConsentService } from "../application/capture-consent.js";
import type { CaptureModelUsageService } from "../application/capture-model-usage.js";
export function accountApp(
  service: AccountService,
  verifyUser: (token: string) => Promise<Identity>,
  serviceIdentity: ServiceIdentity,
  modelUsage?: ModelUsageService,
  captureConsents?: CaptureConsentService,
  captureModels?: CaptureModelUsageService,
) {
  const app = Fastify({
    bodyLimit: 16_000,
    logger: privateHttpLogger,
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
        if (request.routeOptions.url?.includes("/capture-processing/model-usage/")) {
          if (hop.caller !== "intelligence") throw new AppError("FORBIDDEN", 403);
          return;
        }
        if (request.routeOptions.url?.includes("/capture-processing/")) {
          const path = request.routeOptions.url;
          const allowed = path.endsWith("/withdrawal-cleanup")
            ? ["ingest"]
            : path.endsWith("/authorize")
              ? ["workspace", "ingest", "intelligence"]
              : path.includes("/deletions/")
                ? ["ingest"]
                : path.endsWith("/consents") && request.method === "POST"
                  ? ["ingest"]
                  : ["gateway"];
          if (!allowed.includes(hop.caller)) throw new AppError("FORBIDDEN", 403);
          return;
        }
        if (request.routeOptions.url?.includes("/model-usage/")) {
          if (hop.caller !== "intelligence" || hop.actor.operationGrantId)
            throw new AppError("FORBIDDEN", 403);
          return;
        }
        const notificationMembership = request.routeOptions.url?.endsWith(
          "/notifications/membership",
        );
        const capability = request.routeOptions.url?.split("/").at(-1);
        if (notificationMembership && !["notification", "workspace"].includes(hop.caller))
          throw new AppError("FORBIDDEN", 403);
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
        const allowed =
          capability === "operation"
            ? ["integration", "workspace"]
            : capability === "disable-connection"
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
      const consentService = () => {
        if (!captureConsents) throw new AppError("CAPTURE_PROCESSING_NOT_CONFIGURED", 503);
        return captureConsents;
      };
      routes.post("/capture-processing/consents", (request) => {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return consentService().create(actor(request), key, request.body);
      });
      routes.get("/capture-processing/consents", (request) =>
        consentService().list(actor(request), (request.query as { captureId?: string }).captureId),
      );
      routes.post("/capture-processing/consents/:consentId/revoke", (request) => {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
        return consentService().revoke(
          actor(request),
          key,
          id.parse((request.params as { consentId: string }).consentId),
          request.body,
        );
      });
      routes.post("/capture-processing/authorize", (request) =>
        consentService().authorize(actor(request), request.body),
      );
      routes.post("/capture-processing/withdrawal-cleanup", (request) =>
        consentService().withdrawalCleanup(actor(request), request.body),
      );
      routes.post("/capture-processing/deletions/:deletionId", (request) =>
        consentService().cleanup(
          actor(request).workspaceId,
          id.parse((request.params as { deletionId: string }).deletionId),
          request.body,
        ),
      );
      routes.post("/model-usage/reservations", (request) => {
        if (!modelUsage) throw new AppError("MODEL_USAGE_UNAVAILABLE", 503);
        return modelUsage.reserve(actor(request), request.body);
      });
      routes.post("/capture-processing/model-usage/reservations", (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!captureModels) throw new AppError("CAPTURE_MODEL_ADMISSION_NOT_CONFIGURED", 503);
        return captureModels.reserve(actor(request), request.body);
      });
      routes.post(
        "/capture-processing/model-usage/reservations/:reservationId/record",
        (request, reply) => {
          reply.header("cache-control", "no-store");
          if (!captureModels) throw new AppError("CAPTURE_MODEL_ADMISSION_NOT_CONFIGURED", 503);
          return captureModels.record(
            actor(request),
            id.parse((request.params as { reservationId: string }).reservationId),
            request.body,
          );
        },
      );
      routes.post("/model-usage/reservations/:reservationId/record", (request) => {
        if (!modelUsage) throw new AppError("MODEL_USAGE_UNAVAILABLE", 503);
        return modelUsage.record(
          actor(request),
          id.parse((request.params as { reservationId: string }).reservationId),
          request.body,
        );
      });
      routes.post("/notifications/membership", (request) =>
        service.notificationMembership(actor(request), request.body),
      );
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
