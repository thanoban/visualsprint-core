import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import {
  processingConsentProof,
  requireProcessingActor,
  type ProcessingConsentAuthority,
  type ProcessingContextInput,
} from "../application/capture-processing-context.js";
export class AccountCaptureProcessing implements ProcessingConsentAuthority {
  private readonly baseUrl: string;
  constructor(
    origin: string,
    private readonly privateKey: CryptoKey,
    private readonly keyId: string,
    private readonly transport: typeof fetch = fetch,
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
          ["127.0.0.1", "localhost"].includes(url.hostname)
        ))
    )
      throw new Error("INVALID_ACCOUNT_PROCESSING_ORIGIN");
    this.baseUrl = url.origin;
  }
  async authorize(actor: Actor, input: ProcessingContextInput) {
    requireProcessingActor(actor, input);
    const token = await serviceToken({
      caller: "workspace",
      audience: "account",
      actor,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await this.transport(
        new URL(
          `/internal/workspaces/${actor.workspaceId}/capture-processing/authorize`,
          this.baseUrl,
        ),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
          redirect: "error",
          signal: AbortSignal.timeout(3000),
        },
      );
    } catch {
      throw new AppError("ACCOUNT_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404].includes(response.status) ? "FORBIDDEN" : "ACCOUNT_UNAVAILABLE",
        [401, 403, 404].includes(response.status) ? 403 : 503,
      );
    }
    try {
      return processingConsentProof.parse(await boundedJson(response, 16000));
    } catch {
      throw new AppError("ACCOUNT_UNAVAILABLE", 503);
    }
  }
}
