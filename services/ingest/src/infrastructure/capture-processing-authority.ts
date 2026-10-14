import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type {
  ProcessingAuthority,
  ProcessingBinding,
  ProcessingIntent,
} from "../application/capture-processing.js";
const grant = z.object({
  consentId: id,
  workspaceId: id,
  ownerId: id,
  meetingId: id,
  captureId: id,
  version: z.number().int().positive(),
  policyVersion: z.literal("english-text-v1"),
  active: z.literal(true),
});
export class CaptureProcessingAuthorities implements ProcessingAuthority {
  private readonly origins: { account: string; workspace: string };
  constructor(
    origins: { account: string; workspace: string },
    private readonly privateKey: CryptoKey,
    private readonly keyId: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const origin = (value: string) => {
      const url = new URL(value);
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
        throw new Error("INVALID_PROCESSING_AUTHORITY_ORIGIN");
      return url.origin;
    };
    this.origins = { account: origin(origins.account), workspace: origin(origins.workspace) };
  }
  private async request(
    actor: Actor,
    audience: "account" | "workspace",
    path: string,
    body: unknown,
    key?: string,
    method: "GET" | "POST" = "POST",
  ) {
    const token = await serviceToken({
      caller: "ingest",
      audience,
      actor,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await this.transport(
        new URL(
          `/internal/workspaces/${id.parse(actor.workspaceId)}/${path}`,
          this.origins[audience],
        ),
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(method === "POST" ? { "content-type": "application/json" } : {}),
            ...(key ? { "idempotency-key": key } : {}),
          },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      throw new AppError("PROCESSING_AUTHORITY_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404].includes(response.status)
          ? "PROCESSING_FORBIDDEN"
          : response.status === 409
            ? "PROCESSING_CONTEXT_CHANGED"
            : "PROCESSING_AUTHORITY_UNAVAILABLE",
        [401, 403, 404].includes(response.status) ? 403 : response.status === 409 ? 409 : 503,
      );
    }
    try {
      return await boundedJson(response, 16000);
    } catch {
      throw new AppError("INVALID_PROCESSING_AUTHORITY", 503);
    }
  }
  async owner(actor: Actor, meetingId: string) {
    const reply = z
      .object({ meetingId: id, ownerId: id })
      .strict()
      .parse(
        await this.request(
          actor,
          "workspace",
          `meetings/${id.parse(meetingId)}/manage-context`,
          undefined,
          undefined,
          "GET",
        ),
      );
    if (reply.meetingId !== meetingId || reply.ownerId !== actor.actorId)
      throw new AppError("PROCESSING_FORBIDDEN", 403);
  }
  async grant(actor: Actor, binding: ProcessingBinding) {
    return grant
      .strict()
      .parse(await this.request(actor, "account", "capture-processing/authorize", binding));
  }
  async workspace(actor: Actor, binding: ProcessingBinding) {
    return z
      .object({ meetingId: id, ownerId: id, meetingVersion: z.number().int().positive() })
      .strict()
      .parse(
        await this.request(
          actor,
          "workspace",
          `meetings/${binding.meetingId}/capture-processing-context`,
          binding,
        ),
      );
  }
  async create(actor: Actor, captureId: string) {
    return grant
      .extend({ createdAt: z.string().datetime() })
      .strict()
      .parse(
        await this.request(
          actor,
          "account",
          "capture-processing/consents",
          { captureId, consent: true, policyVersion: "english-text-v1" },
          `processing:${captureId}:english-text-v1`,
        ),
      );
  }
  async withdraw(actor: Actor, intent: ProcessingIntent) {
    return z
      .object({
        captureId: id,
        meetingId: id,
        consentId: id.nullable(),
        version: z.number().int().positive().nullable(),
        active: z.literal(false),
        creationBlocked: z.literal(true),
      })
      .strict()
      .parse(
        await this.request(actor, "account", "capture-processing/withdrawal-cleanup", {
          captureId: intent.captureId,
          meetingId: intent.meetingId,
          policyVersion: intent.policyVersion,
        }),
      );
  }
  async cleanup(workspaceId: string, meetingId: string, deletionId: string, sourceVersion: number) {
    const reply = z
      .object({ deletionId: id, meetingId: id, state: z.literal("complete") })
      .strict()
      .parse(
        await this.request(
          { workspaceId, actorId: deletionId, sessionId: `deletion:${deletionId}` },
          "account",
          `capture-processing/deletions/${deletionId}`,
          { meetingId, sourceVersion },
        ),
      );
    if (reply.deletionId !== deletionId || reply.meetingId !== meetingId)
      throw new AppError("INVALID_PROCESSING_DELETION_ACK", 503);
  }
}
