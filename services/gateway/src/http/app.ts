import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import {
  AppError,
  bearer,
  identityToken,
  installErrorHandler,
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
    logger: { redact: ["req.headers.authorization", "req.body"] },
  });
  installErrorHandler(app);
  const identities = new WeakMap<object, Identity>();
  app.get("/health", async () => ({ status: "ok", service: "gateway" }));
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
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 1_000_000) throw new AppError("UPSTREAM_RESPONSE_TOO_LARGE", 503);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AppError("UPSTREAM_UNAVAILABLE", 503);
    }
    if (JSON.stringify(data).length > 1_000_000)
      throw new AppError("UPSTREAM_RESPONSE_TOO_LARGE", 503);
    return { status: response.status, data };
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
        const isMembers = /^members$/.test(params["*"]);
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
        const path = isMembers ? `/internal/workspaces/${workspaceId}/members` : request.url;
        const result = await upstream(new URL(path, target), headers, request.method, request.body);
        return reply.code(result.status).send(result.data);
      });
    },
    { prefix: "/api/v3" },
  );
  return app;
}
