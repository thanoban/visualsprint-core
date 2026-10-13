import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import {
  acceptedFingerprint,
  reviewedCitation,
  type Citation,
  type CommitmentEvidence,
  type EvidenceProof,
} from "../application/commitments.js";
const evidenceRow = reviewedCitation.extend({
  captureVersion: z.number().int().positive(),
  state: z.enum(["complete", "partial"]),
  coverage: z.enum(["no_detected_gaps", "known_gaps", "unknown"]),
  text: z.string().min(1).max(32000),
  finalized: z.literal(true),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  speakerLabel: z.string().max(200).nullable(),
});
const batch = z.object({ meetingId: id, segments: z.array(evidenceRow).min(1).max(20) });
const citation = z.object({
  meetingId: id,
  captureId: id,
  segmentId: id,
  revision: z.number().int().positive(),
});
const job = z.object({
  id,
  status: z.literal("complete"),
  result: z.object({
    claims: z
      .array(
        z.object({
          kind: z.enum(["discussion", "decision", "commitment"]),
          text: z.string().min(1).max(32000),
          citation,
        }),
      )
      .max(1000),
    reviewRequired: z.literal(true),
  }),
});
function origin(value: string) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    (u.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname)
      ))
  )
    throw new Error("INVALID_REVIEW_SOURCE_ORIGIN");
  return u.origin;
}
export class AuthorizedCommitmentEvidence implements CommitmentEvidence {
  private readonly ingestOrigin: string;
  private readonly intelligenceOrigin: string | null;
  constructor(
    ingest: string,
    intelligence: string | undefined,
    private readonly key: CryptoKey,
    private readonly keyId: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.ingestOrigin = origin(ingest);
    this.intelligenceOrigin = intelligence ? origin(intelligence) : null;
  }
  private async call(
    actor: Actor,
    audience: "ingest" | "intelligence",
    path: string,
    body?: unknown,
  ) {
    const token = await serviceToken({
      caller: "workspace",
      audience,
      actor,
      privateKey: this.key,
      keyId: this.keyId,
    });
    const base = audience === "ingest" ? this.ingestOrigin : this.intelligenceOrigin;
    if (!base) throw new AppError("PROPOSAL_REVIEW_NOT_CONFIGURED", 503);
    let response: Response;
    try {
      response = await this.transport(new URL(path, base), {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(4000),
        redirect: "error",
      });
    } catch {
      throw new AppError("REVIEW_SOURCE_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        "SOURCE_EVIDENCE_CHANGED",
        [401, 403, 404, 409].includes(response.status) ? response.status : 503,
      );
    }
    return boundedJson(response, 1000000);
  }
  async validate(actor: Actor, meetingId: string, citations: Citation[]): Promise<EvidenceProof> {
    try {
      const proof = batch.parse(
        await this.call(
          actor,
          "ingest",
          `/internal/workspaces/${actor.workspaceId}/evidence-batch`,
          { meetingId, citations },
        ),
      );
      const requested = new Set(
        citations.map((c) => `${c.captureId}:${c.segmentId}:${c.revision}`),
      );
      if (
        proof.meetingId !== meetingId ||
        proof.segments.length !== citations.length ||
        proof.segments.some(
          (row) => !requested.delete(`${row.captureId}:${row.segmentId}:${row.revision}`),
        ) ||
        requested.size
      )
        throw new AppError("SOURCE_EVIDENCE_CHANGED", 409);
      const sorted = [...proof.segments].sort((a, b) =>
        `${a.captureId}:${a.segmentId}`.localeCompare(`${b.captureId}:${b.segmentId}`),
      );
      return {
        meetingId,
        citations: sorted.map((row) => ({
          captureId: row.captureId,
          segmentId: row.segmentId,
          revision: row.revision,
          captureVersion: row.captureVersion,
          coverage:
            row.state === "complete" && row.coverage === "no_detected_gaps"
              ? "complete"
              : row.coverage === "unknown"
                ? "unknown"
                : "partial",
        })),
        partial: sorted.some(
          (row) => row.state !== "complete" || row.coverage !== "no_detected_gaps",
        ),
        fingerprint: acceptedFingerprint(sorted),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("REVIEW_SOURCE_UNAVAILABLE", 503);
    }
  }
  async proposal(actor: Actor, jobId: string, claimIndex: number) {
    try {
      const result = job.parse(
        await this.call(
          actor,
          "intelligence",
          `/api/v3/workspaces/${actor.workspaceId}/intelligence/jobs/${id.parse(jobId)}`,
        ),
      );
      const claim = result.result.claims[claimIndex];
      if (result.id !== jobId || !claim) throw new AppError("PROPOSAL_NOT_AVAILABLE", 409);
      return { jobId, claimIndex, ...claim };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("PROPOSAL_NOT_AVAILABLE", 409);
    }
  }
}
