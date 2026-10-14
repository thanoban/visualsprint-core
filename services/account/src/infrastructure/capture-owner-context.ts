import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type { CaptureOwnerContext } from "../application/capture-consent.js";
export class IngestCaptureOwnerContext implements CaptureOwnerContext {
  private readonly origin: string;
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
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          process.env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        ))
    )
      throw new Error("INVALID_INGEST_ORIGIN");
    this.origin = url.origin;
  }
  async read(actor: Actor, captureId: string) {
    const token = await serviceToken({
      caller: "account",
      audience: "ingest",
      actor,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await this.transport(
        new URL(
          `/internal/workspaces/${id.parse(actor.workspaceId)}/captures/${id.parse(captureId)}/processing-owner-context`,
          this.origin,
        ),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      throw new AppError("PROCESSING_OWNER_CONTEXT_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404].includes(response.status)
          ? "PROCESSING_OWNER_FORBIDDEN"
          : "PROCESSING_OWNER_CONTEXT_UNAVAILABLE",
        [401, 403, 404].includes(response.status) ? 403 : 503,
      );
    }
    try {
      return z
        .object({
          captureId: id,
          meetingId: id,
          ownerId: id,
          policyVersion: z.literal("english-text-v1"),
          optedIn: z.literal(true),
        })
        .strict()
        .parse(await boundedJson(response, 8000));
    } catch {
      throw new AppError("INVALID_PROCESSING_OWNER_CONTEXT", 503);
    }
  }
}
