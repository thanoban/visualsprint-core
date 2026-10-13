import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type { Authority, Connector } from "../application/ports.js";
import type { ExecutionIntent } from "../domain/action.js";
const outcome = z.discriminatedUnion("state", [
  z.object({ state: z.literal("confirmed"), externalId: z.string().min(1).max(300) }).strict(),
  z.object({ state: z.literal("rejected"), code: z.string().regex(/^[A-Z0-9_]{1,80}$/) }).strict(),
  z.object({ state: z.literal("unknown") }).strict(),
]);
const reconciled = z.union([
  outcome,
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("not_created") }).strict(),
]);
class SignedClient {
  constructor(
    private readonly origin: string,
    private readonly audience: string,
    private readonly key: CryptoKey,
    private readonly keyId: string,
  ) {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          process.env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        ))
    )
      throw new Error("INVALID_SERVICE_ORIGIN");
  }
  async call(actor: Actor, path: string, body?: unknown) {
    const token = await serviceToken({
      caller: "workflow",
      audience: this.audience,
      actor,
      privateKey: this.key,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await fetch(new URL(path, this.origin), {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AppError("DEPENDENCY_RESPONSE_UNKNOWN", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404].includes(response.status) ? "FORBIDDEN" : "DEPENDENCY_UNAVAILABLE",
        [401, 403, 404].includes(response.status) ? response.status : 503,
      );
    }
    try {
      return await boundedJson(response, 32000);
    } catch {
      throw new AppError("DEPENDENCY_RESPONSE_UNKNOWN", 503);
    }
  }
}
export class WorkspaceActions implements Authority {
  private readonly client: SignedClient;
  constructor(origin: string, key: CryptoKey, keyId: string) {
    this.client = new SignedClient(origin, "workspace", key, keyId);
  }
  async requireSource(actor: Actor, meetingId: string) {
    const result = z
      .object({ id, ownerId: id, version: z.number().int().positive() })
      .parse(
        await this.client.call(
          actor,
          `/api/v3/workspaces/${actor.workspaceId}/meetings/${meetingId}`,
        ),
      );
    if (result.id !== meetingId) throw new AppError("DEPENDENCY_RESPONSE_UNKNOWN", 503);
    return { ownerId: result.ownerId, version: result.version };
  }
}
export class IntegrationActions implements Connector {
  private readonly client: SignedClient;
  constructor(origin: string, key: CryptoKey, keyId: string) {
    this.client = new SignedClient(origin, "integration", key, keyId);
  }
  async execute(actor: Actor, intent: ExecutionIntent) {
    return outcome.parse(
      await this.client.call(
        actor,
        `/internal/workspaces/${actor.workspaceId}/action-executions`,
        intent,
      ),
    );
  }
  async reconcile(actor: Actor, intent: ExecutionIntent) {
    return reconciled.parse(
      await this.client.call(
        actor,
        `/internal/workspaces/${actor.workspaceId}/action-executions/${intent.operationId}/reconcile`,
        intent,
      ),
    );
  }
}
export class DisabledConnector implements Connector {
  async execute() {
    return { state: "rejected" as const, code: "ACTION_CONNECTORS_NOT_CONFIGURED" };
  }
  async reconcile() {
    return { state: "pending" as const };
  }
}
