import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type {
  CaptureModelReadiness,
  CaptureModelRequest,
} from "../application/capture-model-usage.js";
export class IngestCaptureModelReadiness implements CaptureModelReadiness {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly key: CryptoKey,
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
      throw new Error("INVALID_INGEST_ORIGIN");
    this.origin = url.origin;
  }
  async assertReady(actor: Actor, input: CaptureModelRequest) {
    const token = await serviceToken({
      caller: "account",
      audience: "ingest",
      actor,
      privateKey: this.key,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await this.transport(
        new URL(
          `/internal/workspaces/${id.parse(actor.workspaceId)}/captures/${input.proof.captureId}/processing-ready-context`,
          this.origin,
        ),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            proof: input.proof,
            transcriptRevision: input.transcriptRevision,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      throw new AppError("CAPTURE_MODEL_SOURCE_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404].includes(response.status)
          ? "CAPTURE_MODEL_SOURCE_FORBIDDEN"
          : response.status === 409
            ? "CAPTURE_MODEL_SOURCE_CHANGED"
            : "CAPTURE_MODEL_SOURCE_UNAVAILABLE",
        [401, 403, 404].includes(response.status) ? 403 : response.status === 409 ? 409 : 503,
      );
    }
    let reply;
    try {
      reply = z
        .object({
          workspaceId: id,
          captureId: id,
          meetingId: id,
          ownerId: id,
          consentId: id,
          consentVersion: z.number().int().positive(),
          policyVersion: z.literal("english-text-v1"),
          transcriptRevision: z.number().int().positive(),
          state: z.enum(["complete", "partial"]),
          ready: z.literal(true),
        })
        .strict()
        .parse(await boundedJson(response, 8000));
    } catch {
      throw new AppError("INVALID_CAPTURE_MODEL_SOURCE", 503);
    }
    if (
      reply.workspaceId !== actor.workspaceId ||
      reply.ownerId !== actor.actorId ||
      reply.captureId !== input.proof.captureId ||
      reply.meetingId !== input.proof.meetingId ||
      reply.consentId !== input.proof.consentId ||
      reply.consentVersion !== input.proof.expectedVersion ||
      reply.policyVersion !== input.proof.policyVersion ||
      reply.transcriptRevision !== input.transcriptRevision
    )
      throw new AppError("CAPTURE_MODEL_SOURCE_MISMATCH", 403);
  }
}
