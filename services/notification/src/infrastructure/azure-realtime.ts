import { createHash } from "node:crypto";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson } from "@visualsprint/platform";
import type { RealtimePort } from "../application/ports.js";
import type { EmailCredential } from "./azure-email.js";

const hub = "visualsprint_notifications";
const apiVersion = "2024-01-01";
const scope = "https://webpubsub.azure.com/.default";
const tokenResponse = z.object({
  token: z
    .string()
    .min(16)
    .max(12000)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});

export function recipient(workspaceId: string, userId: string) {
  return createHash("sha256")
    .update(JSON.stringify([id.parse(workspaceId), id.parse(userId)]))
    .digest("hex");
}

export class DisabledRealtime implements RealtimePort {
  readonly configured = false;
  async negotiate(): Promise<{ url: string; expiresAt: string }> {
    throw new AppError("REALTIME_NOT_CONFIGURED", 503);
  }
  async invalidate() {}
}

/** Native managed-identity REST transport; no connection strings, group roles or public data. */
export class AzureRealtime implements RealtimePort {
  readonly configured = true;
  private readonly endpoint: URL;
  constructor(
    endpoint: string,
    private readonly credential: EmailCredential,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.endpoint = new URL(endpoint);
    if (
      this.endpoint.protocol !== "https:" ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.port ||
      this.endpoint.pathname !== "/" ||
      this.endpoint.search ||
      this.endpoint.hash ||
      !/^[a-z0-9][a-z0-9-]*\.webpubsub\.azure\.com$/.test(this.endpoint.hostname)
    )
      throw new Error("INVALID_REALTIME_ENDPOINT");
  }
  private async request(path: string, query: Record<string, string>, body?: string) {
    const url = new URL(`/api/hubs/${hub}/${path}`, this.endpoint);
    url.searchParams.set("api-version", apiVersion);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2000);
    let token: { token: string; expiresOnTimestamp: number } | null;
    try {
      token = await Promise.race([
        this.credential.getToken(scope, { abortSignal: abort.signal }),
        new Promise<never>((_resolve, reject) =>
          abort.signal.addEventListener("abort", () => reject(new Error("IDENTITY_DEADLINE")), {
            once: true,
          }),
        ),
      ]);
    } catch {
      throw new AppError("REALTIME_IDENTITY_UNAVAILABLE", 503);
    } finally {
      clearTimeout(timer);
    }
    if (!token?.token || token.expiresOnTimestamp <= Date.now() + 5000)
      throw new AppError("REALTIME_IDENTITY_UNAVAILABLE", 503);
    try {
      return await this.transport(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new AppError("REALTIME_UNAVAILABLE", 503);
    }
  }
  async negotiate(workspaceId: string, userId: string) {
    const response = await this.request(":generateToken", {
      userId: recipient(workspaceId, userId),
      minutesToExpire: "2",
      // Omitted role/group parameters are intentional: never grant join or send permissions.
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new AppError("REALTIME_UNAVAILABLE", 503);
    }
    try {
      const { token } = tokenResponse.parse(await boundedJson(response, 16000));
      // Never forward an accessUrl supplied by the provider. The destination is locally pinned.
      const url = new URL(`/client/hubs/${hub}`, this.endpoint);
      url.protocol = "wss:";
      url.searchParams.set("access_token", token);
      return { url: url.toString(), expiresAt: new Date(Date.now() + 120000).toISOString() };
    } catch {
      throw new AppError("REALTIME_UNAVAILABLE", 503);
    }
  }
  async invalidate(workspaceId: string, userId: string) {
    const response = await this.request(
      `users/${recipient(workspaceId, userId)}/:send`,
      { messageTtlSeconds: "15" },
      JSON.stringify({ type: "notifications.invalidate.v1" }),
    );
    await response.body?.cancel();
    if (response.status !== 202) throw new AppError("REALTIME_UNAVAILABLE", 503);
  }
}
