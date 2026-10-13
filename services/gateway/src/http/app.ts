import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import {
  AppError,
  boundedJson,
  boundedText,
  bearer,
  identityToken,
  installErrorHandler,
  privateHttpLogger,
  serviceToken,
  type Actor,
  type Identity,
} from "@visualsprint/platform";
import { routeService, type CellService } from "../application/routing.js";

export type GatewayConfig = {
  accountUrl: string;
  cells: Record<string, Partial<Record<CellService, string | undefined>>>;
  privateKey: CryptoKey;
  keyId: string;
};
export function gatewayApp(
  config: GatewayConfig,
  verifyUser: (token: string) => Promise<Identity>,
  transport: typeof fetch = fetch,
) {
  const app = Fastify({
    bodyLimit: 48_000,
    logger: privateHttpLogger,
  });
  installErrorHandler(app);
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  const identities = new WeakMap<object, Identity>();
  app.get("/health", async () => ({ status: "ok", service: "gateway" }));
  // Provider callbacks are authenticated by Ingest against the original bytes,
  // not by a user's login. Routes resolve only operator-configured cell origins.
  app.register(
    async (routes) => {
      routes.removeContentTypeParser("application/json");
      routes.addContentTypeParser(
        "application/json",
        { parseAs: "buffer", bodyLimit: 1_000_000 },
        (_request, body, done) => done(null, body),
      );
      routes.post("/cells/:cellId/recall", { bodyLimit: 1_000_000 }, async (request, reply) => {
        const cellId = z
          .string()
          .regex(/^[a-z0-9-]{1,100}$/)
          .parse((request.params as { cellId: string }).cellId);
        const origin = config.cells[cellId]?.ingest;
        if (!origin) throw new AppError("NOT_FOUND", 404);
        const headers: Record<string, string> = { "content-type": "application/json" };
        for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
          const value = request.headers[name];
          if (typeof value !== "string" || value.length > 2048)
            throw new AppError("INVALID_WEBHOOK_SIGNATURE", 401);
          headers[name] = value;
        }
        let response: Response;
        try {
          response = await transport(new URL("/webhooks/v3/recall", origin), {
            method: "POST",
            headers,
            body: new Uint8Array(request.body as Buffer),
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          throw new AppError("UPSTREAM_UNAVAILABLE", 503);
        }
        await response.body?.cancel();
        if (response.status === 204) return reply.code(204).send();
        const status = [400, 401, 404, 409, 413, 429].includes(response.status)
          ? response.status
          : 503;
        throw new AppError("PROVIDER_CALLBACK_REJECTED", status);
      });
      async function forwardCalendar(request: FastifyRequest, reply: FastifyReply, token?: string) {
        const params = z.object({ cellId: z.string().regex(/^[a-z0-9-]{1,100}$/),
          provider: z.enum(["google", "microsoft"]) }).parse(request.params);
        const origin = config.cells[params.cellId]?.integration;
        if (!origin) throw new AppError("NOT_FOUND", 404);
        const target = new URL(`/internal/calendar/webhooks/${params.provider}`, origin);
        if (token !== undefined) target.searchParams.set("validationToken", token);
        const headers: Record<string, string> = {};
        if (params.provider === "google") for (const name of ["x-goog-channel-id", "x-goog-channel-token",
          "x-goog-resource-id", "x-goog-resource-state", "x-goog-message-number", "x-goog-channel-expiration"]) {
          const value = request.headers[name];
          if (value !== undefined) headers[name] = z.string().max(2048).parse(value);
        }
        const body = token === undefined && Buffer.isBuffer(request.body) && request.body.length
          ? new Uint8Array(request.body) : undefined;
        if (body) headers["content-type"] = "application/json";
        let response: Response;
        try { response = await transport(target, { method: "POST", headers,
          ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(5000) }); }
        catch { throw new AppError("UPSTREAM_UNAVAILABLE", 503); }
        if (token !== undefined && response.status === 200) {
          const echoed = await boundedText(response, 4096);
          if (echoed !== token) throw new AppError("PROVIDER_CALLBACK_REJECTED", 503);
          return reply.type("text/plain; charset=utf-8").code(200).send(echoed);
        }
        await response.body?.cancel();
        if (token === undefined && [202, 204].includes(response.status)) return reply.code(response.status).send();
        throw new AppError("PROVIDER_CALLBACK_REJECTED",
          [400, 401, 403, 404, 409, 413, 429].includes(response.status) ? response.status : 503);
      }
      routes.post("/cells/:cellId/calendars/:provider", {
        bodyLimit: 24_000,
        onRequest: async (request, reply) => {
          const params = request.params as { provider: string };
          const query = request.query as { validationToken?: unknown };
          if (query.validationToken !== undefined) {
            if (params.provider !== "microsoft") throw new AppError("INVALID_REQUEST", 400);
            const token = z.string().min(1).max(2048).parse(query.validationToken);
            await forwardCalendar(request, reply, token);
          }
        },
      }, async (request, reply) => forwardCalendar(request, reply));
    },
    { prefix: "/webhooks/v3" },
  );
  async function upstream(
    url: URL,
    headers: Record<string, string>,
    method: string,
    body?: unknown,
  ) {
    let response: Response;
    if (body === undefined) {
      headers = { ...headers };
      delete headers["content-type"];
    }
    try {
      response = await transport(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AppError("UPSTREAM_UNAVAILABLE", 503);
    }
    const download = /\/exports\/[0-9a-f-]+\/download$/i.test(url.pathname) && method === "GET";
    let data: unknown;
    try {
      data =
        download && response.ok && response.headers.get("content-type")?.startsWith("text/plain")
          ? await boundedText(response, 2_100_000)
          : await boundedJson(response, download ? 2_100_000 : 1_000_000);
    } catch {
      throw new AppError("UPSTREAM_UNAVAILABLE", 503);
    }
    return {
      status: response.status,
      data,
      contentType: download && response.ok ? response.headers.get("content-type") : null,
    };
  }
  async function account(request: FastifyRequest, path: string) {
    const identity = identities.get(request)!;
    const proof = await identityToken({
      caller: "gateway",
      audience: "account",
      identity,
      keyId: config.keyId,
      privateKey: config.privateKey,
    });
    const headers: Record<string, string> = {
      authorization: request.headers.authorization!,
      "x-service-authorization": `Bearer ${proof}`,
      "content-type": "application/json",
    };
    if (typeof request.headers["idempotency-key"] === "string")
      headers["idempotency-key"] = request.headers["idempotency-key"];
    return upstream(new URL(path, config.accountUrl), headers, request.method, request.body);
  }
  // Header construction uses the original request object so identity cannot be lost during composition.
  async function currentActor(request: FastifyRequest, workspaceId: string): Promise<Actor> {
    const identity = identities.get(request)!;
    const proof = await identityToken({
      caller: "gateway",
      audience: "account",
      identity,
      keyId: config.keyId,
      privateKey: config.privateKey,
    });
    const result = await upstream(
      new URL("/api/v3/me", config.accountUrl),
      {
        authorization: request.headers.authorization!,
        "x-service-authorization": `Bearer ${proof}`,
      },
      "GET",
    );
    if (result.status !== 200)
      throw new AppError(
        result.status === 401 ? "UNAUTHENTICATED" : "ACCOUNT_UNAVAILABLE",
        result.status === 401 ? 401 : 503,
      );
    return {
      actorId: z.object({ userId: id }).passthrough().parse(result.data).userId,
      workspaceId,
      sessionId: identity.sessionId,
    };
  }
  app.register(
    async (routes) => {
      routes.addHook("preHandler", async (request) => {
        identities.set(request, await verifyUser(bearer(request.headers.authorization)));
      });
      for (const [method, path] of [
        ["GET", "/me"],
        ["POST", "/workspaces"],
        ["POST", "/logout"],
      ] as const) {
        routes.route({
          method,
          url: path,
          handler: async (request, reply) => {
            const result = await account(request, `/api/v3${path}`);
            return reply.code(result.status).send(result.data);
          },
        });
      }
      routes.all("/workspaces/:workspaceId/*", async (request, reply) => {
        const params = request.params as { workspaceId: string; "*": string };
        const workspaceId = id.parse(params.workspaceId);
        const delegated = await currentActor(request, workspaceId);
        const accountToken = await serviceToken({
          caller: "gateway",
          audience: "account",
          actor: delegated,
          keyId: config.keyId,
          privateKey: config.privateKey,
        });
        const directory = await upstream(
          new URL(`/internal/workspaces/${workspaceId}/directory`, config.accountUrl),
          { authorization: `Bearer ${accountToken}` },
          "GET",
        );
        if (directory.status !== 200) {
          const status =
            directory.status === 401 ? 401 : [403, 404].includes(directory.status) ? 403 : 503;
          throw new AppError(
            status === 401
              ? "UNAUTHENTICATED"
              : status === 403
                ? "FORBIDDEN"
                : "ACCOUNT_UNAVAILABLE",
            status,
          );
        }
        const cellId = z
          .object({ cellId: z.string().min(1) })
          .passthrough()
          .parse(directory.data).cellId;
        const isMembers = /^(?:members|automation-grants(?:\/revoke)?)$/.test(params["*"]);
        const service = routeService(params["*"]);
        const target = isMembers
          ? config.accountUrl
          : service
            ? config.cells[cellId]?.[service]
            : undefined;
        if (!target)
          throw new AppError(service ? "SERVICE_NOT_CONFIGURED" : "NOT_FOUND", service ? 503 : 404);
        const token = await serviceToken({
          caller: "gateway",
          audience: isMembers ? "account" : service!,
          actor: delegated,
          keyId: config.keyId,
          privateKey: config.privateKey,
        });
        const headers: Record<string, string> = {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        };
        if (typeof request.headers["idempotency-key"] === "string")
          headers["idempotency-key"] = request.headers["idempotency-key"];
        const path = isMembers ? `/internal/workspaces/${workspaceId}/${params["*"]}` : request.url;
        const result = await upstream(new URL(path, target), headers, request.method, request.body);
        if (result.contentType?.startsWith("text/plain")) reply.type("text/plain; charset=utf-8");
        return reply.code(result.status).send(result.data);
      });
    },
    { prefix: "/api/v3" },
  );
  return app;
}
