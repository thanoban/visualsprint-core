import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import { internalOrigin } from "./sources.js";
import {
  processingActor,
  processingBinding,
  type FinalizedCaptureProof,
  type CaptureExtractionEvidence,
  type CaptureExtractionAdmission,
} from "../application/capture-extraction.js";
import type { Snapshot } from "../domain/evidence.js";
import { PostgresModelDispatch } from "./model-dispatch.js";

export class CaptureProcessingClient {
  private readonly origins: Record<"account" | "workspace" | "ingest", string>;
  constructor(
    origins: Record<"account" | "workspace" | "ingest", string>,
    private readonly key: CryptoKey,
    private readonly keyId: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.origins = {
      account: internalOrigin(origins.account),
      workspace: internalOrigin(origins.workspace),
      ingest: internalOrigin(origins.ingest),
    };
  }
  async request(
    actor: Actor,
    audience: "account" | "workspace" | "ingest",
    path: string,
    body?: unknown,
  ) {
    const workspaceId = id.parse(actor.workspaceId);
    const ownerRead =
      audience === "workspace" &&
      body === undefined &&
      !actor.operationGrantId &&
      !actor.sessionId.startsWith("operation:") &&
      new RegExp(`^/api/v3/workspaces/${workspaceId}/meetings/[0-9a-f-]{36}$`, "i").test(path);
    if (!path.startsWith(`/internal/workspaces/${workspaceId}/`) && !ownerRead)
      throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
    const token = await serviceToken({
      caller: "intelligence",
      audience,
      actor,
      privateKey: this.key,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.origins[audience]), {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AppError("CAPTURE_PROCESSING_DEPENDENCY_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404].includes(response.status)
          ? "PROCESSING_FORBIDDEN"
          : response.status === 409
            ? "PROCESSING_SOURCE_CHANGED"
            : [402, 429].includes(response.status)
              ? "MODEL_BUDGET_EXHAUSTED"
              : "CAPTURE_PROCESSING_DEPENDENCY_UNAVAILABLE",
        [401, 403, 404].includes(response.status)
          ? 403
          : response.status === 409
            ? 409
            : [402, 429].includes(response.status)
              ? response.status
              : 503,
      );
    }
    try {
      return await boundedJson(response, 4_000_000);
    } catch {
      throw new AppError("INVALID_PROCESSING_RESPONSE", 503);
    }
  }
}
const grant = z
  .object({
    consentId: id,
    workspaceId: id,
    ownerId: id,
    meetingId: id,
    captureId: id,
    version: z.number().int().positive(),
    policyVersion: z.literal("english-text-v1"),
    active: z.literal(true),
  })
  .strict();
const context = z
  .object({ meetingId: id, ownerId: id, meetingVersion: z.number().int().positive() })
  .strict();
const page = z
  .object({
    workspaceId: id,
    captureId: id,
    meetingId: id,
    ownerId: id,
    meetingVersion: z.number().int().positive(),
    transcriptRevision: z.number().int().positive(),
    coverage: z.enum(["no_detected_gaps", "known_gaps", "unknown"]),
    segments: z
      .array(
        z
          .object({
            id,
            revision: z.number().int().positive(),
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().nonnegative(),
            text: z.string().max(32000),
            speakerLabel: z.string().nullable(),
            finalized: z.literal(true),
          })
          .strict(),
      )
      .max(100),
    totalSegments: z.number().int().min(0).max(10000),
    totalBytes: z.number().int().min(0).max(2_000_000),
    nextCursor: z.string().max(100).nullable(),
  })
  .strict();
export class AuthorizedCaptureExtractionEvidence implements CaptureExtractionEvidence {
  constructor(private readonly client: CaptureProcessingClient) {}
  async authorize(proof: FinalizedCaptureProof) {
    const actor = processingActor(proof),
      binding = processingBinding(proof);
    const current = grant.parse(
      await this.client.request(
        actor,
        "account",
        `/internal/workspaces/${proof.workspaceId}/capture-processing/authorize`,
        binding,
      ),
    );
    if (
      current.workspaceId !== proof.workspaceId ||
      current.ownerId !== proof.ownerId ||
      current.meetingId !== proof.meetingId ||
      current.captureId !== proof.captureId ||
      current.consentId !== proof.consentId ||
      current.version !== proof.consentVersion ||
      current.policyVersion !== proof.policyVersion
    )
      throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
    const owner = context.parse(
      await this.client.request(
        actor,
        "workspace",
        `/internal/workspaces/${proof.workspaceId}/meetings/${proof.meetingId}/capture-processing-context`,
        binding,
      ),
    );
    if (owner.meetingId !== proof.meetingId || owner.ownerId !== proof.ownerId)
      throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
  }
  async owner(actor: Actor, meetingId: string) {
    if (actor.operationGrantId || actor.sessionId.startsWith("operation:"))
      throw new AppError("FORBIDDEN", 403);
    const owner = z
      .object({ id, ownerId: id })
      .parse(
        await this.client.request(
          actor,
          "workspace",
          `/api/v3/workspaces/${id.parse(actor.workspaceId)}/meetings/${id.parse(meetingId)}`,
        ),
      );
    if (owner.id !== meetingId || owner.ownerId !== actor.actorId)
      throw new AppError("FORBIDDEN", 403);
  }
  async read(proof: FinalizedCaptureProof): Promise<Snapshot> {
    await this.authorize(proof);
    const evidence: Snapshot["evidence"] = [],
      seen = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | null = null,
      first: z.infer<typeof page> | null = null,
      bytes = 0;
    const deadline = Date.now() + 30000;
    for (let index = 0; index < 101; index++) {
      if (Date.now() > deadline) throw new AppError("PROCESSING_READ_TIMEOUT", 503);
      const result = page.parse(
        await this.client.request(
          processingActor(proof),
          "ingest",
          `/internal/workspaces/${proof.workspaceId}/captures/${proof.captureId}/processing-evidence`,
          { proof: processingBinding(proof), transcriptRevision: proof.transcriptRevision, cursor },
        ),
      );
      if (
        result.workspaceId !== proof.workspaceId ||
        result.captureId !== proof.captureId ||
        result.meetingId !== proof.meetingId ||
        result.ownerId !== proof.ownerId ||
        result.transcriptRevision !== proof.transcriptRevision ||
        (first &&
          (first.meetingVersion !== result.meetingVersion ||
            first.coverage !== result.coverage ||
            first.totalSegments !== result.totalSegments ||
            first.totalBytes !== result.totalBytes))
      )
        throw new AppError("PROCESSING_SOURCE_CHANGED", 409);
      first ??= result;
      for (const row of result.segments) {
        if (seen.has(row.id) || row.endMs < row.startMs)
          throw new AppError("INVALID_PROCESSING_EVIDENCE", 409);
        seen.add(row.id);
        bytes += Buffer.byteLength(row.text, "utf8");
        if (bytes > 2_000_000) throw new AppError("PROCESSING_EVIDENCE_TOO_LARGE", 409);
        evidence.push({
          meetingId: proof.meetingId,
          captureId: proof.captureId,
          segmentId: row.id,
          revision: row.revision,
          startMs: row.startMs,
          endMs: row.endMs,
          text: row.text,
          speakerLabel: row.speakerLabel,
        });
      }
      if (!result.nextCursor) break;
      if (!result.segments.length || cursors.has(result.nextCursor) || index === 100)
        throw new AppError("INVALID_PROCESSING_EVIDENCE", 409);
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    if (!first || evidence.length !== first.totalSegments || bytes !== first.totalBytes)
      throw new AppError("PROCESSING_SOURCE_CHANGED", 409);
    await this.authorize(proof);
    return {
      versions: [
        {
          meetingId: proof.meetingId,
          version: first.meetingVersion,
          captureId: proof.captureId,
          captureVersion: proof.transcriptRevision,
          coverage:
            first.coverage === "no_detected_gaps"
              ? "complete"
              : first.coverage === "known_gaps"
                ? "partial"
                : "unknown",
        },
      ],
      evidence,
    };
  }
}
export class CaptureModelAdmission implements CaptureExtractionAdmission {
  constructor(
    private readonly client: CaptureProcessingClient,
    private readonly dispatch: Pick<PostgresModelDispatch, "intent" | "record">,
  ) {}
  async reserve(
    proof: FinalizedCaptureProof,
    input: Parameters<CaptureExtractionAdmission["reserve"]>[1],
  ) {
    const result = z
      .object({
        reservationId: id,
        replay: z.boolean(),
        state: z.enum(["held", "succeeded", "unknown", "not_started"]),
      })
      .strict()
      .parse(
        await this.client.request(
          processingActor(proof),
          "account",
          `/internal/workspaces/${proof.workspaceId}/capture-processing/model-usage/reservations`,
          {
            ...input,
            purpose: "capture_extraction",
            proof: processingBinding(proof),
            transcriptRevision: proof.transcriptRevision,
          },
        ),
      );
    if (!result.replay && result.state === "held")
      await this.dispatch.intent(processingActor(proof), input.operationId, result.reservationId);
    return result;
  }
  async record(
    proof: FinalizedCaptureProof,
    operationId: string,
    reservationId: string,
    outcome: "succeeded" | "unknown" | "not_started",
  ) {
    const result = z
      .object({ reservationId: id, state: z.enum(["held", "succeeded", "unknown", "not_started"]) })
      .strict()
      .parse(
        await this.client.request(
          processingActor(proof),
          "account",
          `/internal/workspaces/${proof.workspaceId}/capture-processing/model-usage/reservations/${id.parse(reservationId)}/record`,
          { operationId: id.parse(operationId), outcome },
        ),
      );
    if (result.reservationId !== reservationId || result.state !== outcome)
      throw new AppError("INVALID_MODEL_ADMISSION", 503);
    await this.dispatch.record(processingActor(proof), reservationId, outcome);
  }
}
