import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import { internalOrigin } from "./sources.js";

// Only operator-configured origins are usable, never provider/model output.
export class IntelligenceInternalClient {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly audience: "workspace" | "account",
    private readonly privateKey: CryptoKey,
    private readonly keyId: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.origin = internalOrigin(origin);
  }
  async post(actor: Actor, path: string, body: unknown): Promise<unknown> {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    const token = await serviceToken({
      caller: "intelligence",
      audience: this.audience,
      actor,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.origin), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AppError("INTELLIGENCE_DEPENDENCY_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404].includes(response.status)
          ? "SOURCE_FORBIDDEN"
          : response.status === 409
            ? "SOURCE_CHANGED"
            : response.status === 429
              ? "MODEL_BUDGET_EXHAUSTED"
              : "INTELLIGENCE_DEPENDENCY_UNAVAILABLE",
        [401, 403, 404].includes(response.status)
          ? 403
          : response.status === 409
            ? 409
            : response.status === 429
              ? 429
              : 503,
      );
    }
    try {
      return await boundedJson(response, 4_000_000);
    } catch {
      throw new AppError("INTELLIGENCE_DEPENDENCY_UNAVAILABLE", 503);
    }
  }
}
