import { createHash } from "node:crypto";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
export const reviewedCitation = z
  .object({ captureId: id, segmentId: id, revision: z.number().int().positive() })
  .strict();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v + "T00:00:00Z")) &&
      new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v,
  );
export const reviewedContent = z
  .object({
    title: z.string().trim().min(1).max(250),
    text: z.string().trim().min(1).max(12000),
    ownerId: id.nullable(),
    dueDate: date.nullable(),
    citations: z.array(reviewedCitation).min(1).max(20),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.citations.map((c) => c.captureId + ":" + c.segmentId)).size === v.citations.length,
    "Duplicate citation",
  );
export const acceptanceInput = z
  .object({
    meetingId: id,
    expectedMeetingVersion: z.number().int().positive(),
    confirmed: z.literal(true),
    content: reviewedContent,
    proposal: z
      .object({ jobId: id, claimIndex: z.number().int().nonnegative().max(999) })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export const correctionInput = z
  .object({
    expectedVersion: z.number().int().positive(),
    expectedMeetingVersion: z.number().int().positive(),
    confirmed: z.literal(true),
    content: reviewedContent,
  })
  .strict();
export type Citation = z.infer<typeof reviewedCitation>;
export type ReviewedContent = z.infer<typeof reviewedContent>;
export type AcceptedKind = "decision" | "commitment";
export type AcceptedScope = {
  kind: "meeting" | "project" | "customer" | "workspace";
  id: string | null;
};
export type EvidenceProof = {
  meetingId: string;
  citations: (Citation & {
    captureVersion: number;
    coverage: "complete" | "partial" | "unknown";
  })[];
  fingerprint: string;
  partial: boolean;
};
export type ProposalProof = {
  jobId: string;
  claimIndex: number;
  kind: "discussion" | "decision" | "commitment";
  text: string;
  citation: Citation & { meetingId: string };
};
export type AcceptedItem = {
  workspaceId: string;
  id: string;
  meetingId: string;
  createdBy: string;
  reviewedBy: string;
  kind: AcceptedKind;
  title: string;
  text: string;
  ownerId: string | null;
  dueDate: string | null;
  state: "accepted" | "superseded" | "open" | "completed" | "cancelled";
  version: number;
  sourceMeetingVersion: number;
  citations: EvidenceProof["citations"];
  sourceFingerprint: string;
  sourcePartial: boolean;
  proposalRef: {
    jobId: string;
    claimIndex: number;
    kind: ProposalProof["kind"];
    textHash: string;
  } | null;
  humanCorrected: boolean;
  statusSource: "human_review";
  createdAt: string;
  updatedAt: string;
};
export interface CommitmentAuthority {
  meeting(
    actor: Actor,
    meetingId: string,
  ): Promise<{ id: string; ownerId: string; version: number }>;
  readable(actor: Actor, scope: AcceptedScope): Promise<string[]>;
  member(actor: Actor, memberId: string): Promise<void>;
}
export interface CommitmentEvidence {
  validate(actor: Actor, meetingId: string, citations: Citation[]): Promise<EvidenceProof>;
  proposal(actor: Actor, jobId: string, claimIndex: number): Promise<ProposalProof>;
}
export interface CommitmentStore {
  replay(actor: Actor, key: string, command: unknown): Promise<AcceptedItem | undefined>;
  accept(
    actor: Actor,
    key: string,
    input: z.infer<typeof acceptanceInput>,
    kind: AcceptedKind,
    proof: EvidenceProof,
    proposal: ProposalProof | null,
  ): Promise<AcceptedItem>;
  get(ws: string, itemId: string): Promise<AcceptedItem | undefined>;
  list(
    ws: string,
    meetingIds: string[],
    kind: AcceptedKind,
    limit?: 100 | 101,
  ): Promise<AcceptedItem[]>;
  correct(
    actor: Actor,
    key: string,
    item: AcceptedItem,
    input: z.infer<typeof correctionInput>,
    proof: EvidenceProof,
  ): Promise<AcceptedItem>;
  status(
    actor: Actor,
    key: string,
    item: AcceptedItem,
    input: { expectedVersion: number; state: AcceptedItem["state"]; confirmed: true },
  ): Promise<AcceptedItem>;
}
export const acceptedFingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class CommitmentsService {
  constructor(
    private readonly store: CommitmentStore,
    private readonly authority: CommitmentAuthority,
    private readonly evidence: CommitmentEvidence,
  ) {}
  private user(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
  }
  private key(key: string) {
    return z
      .string()
      .min(8)
      .max(200)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .parse(key);
  }
  private async owner(actor: Actor, meetingId: string, expectedVersion?: number) {
    this.user(actor);
    const meeting = await this.authority.meeting(actor, meetingId);
    if (meeting.ownerId !== actor.actorId) throw new AppError("FORBIDDEN", 403);
    if (expectedVersion !== undefined && meeting.version !== expectedVersion)
      throw new AppError("SOURCE_MEETING_CHANGED", 409);
    return meeting;
  }
  private async fields(actor: Actor, kind: AcceptedKind, content: ReviewedContent) {
    if (kind === "decision" && (content.ownerId !== null || content.dueDate !== null))
      throw new AppError("DECISION_HAS_NO_ASSIGNEE_OR_DUE_DATE", 400);
    if (content.ownerId) await this.authority.member(actor, content.ownerId);
  }
  async accept(actor: Actor, key: string, kind: AcceptedKind, body: unknown) {
    const input = acceptanceInput.parse(body);
    this.user(actor);
    this.key(key);
    const replay = await this.store.replay(actor, key, { type: "accept", kind, input });
    if (replay) {
      await this.owner(actor, replay.meetingId);
      return replay;
    }
    await this.owner(actor, input.meetingId, input.expectedMeetingVersion);
    await this.fields(actor, kind, input.content);
    const proof = await this.evidence.validate(actor, input.meetingId, input.content.citations);
    let proposal: ProposalProof | null = null;
    if (input.proposal) {
      proposal = await this.evidence.proposal(
        actor,
        input.proposal.jobId,
        input.proposal.claimIndex,
      );
      if (
        proposal.citation.meetingId !== input.meetingId ||
        !input.content.citations.some(
          (c) =>
            c.captureId === proposal!.citation.captureId &&
            c.segmentId === proposal!.citation.segmentId &&
            c.revision === proposal!.citation.revision,
        )
      )
        throw new AppError("PROPOSAL_SOURCE_MISMATCH", 409);
    }
    const current = await this.evidence.validate(actor, input.meetingId, input.content.citations);
    if (current.fingerprint !== proof.fingerprint)
      throw new AppError("SOURCE_EVIDENCE_CHANGED", 409);
    await this.owner(actor, input.meetingId, input.expectedMeetingVersion);
    return this.store.accept(actor, key, input, kind, proof, proposal);
  }
  private async available(actor: Actor, itemId: string, kind: AcceptedKind) {
    this.user(actor);
    const item = await this.store.get(actor.workspaceId, id.parse(itemId));
    if (!item || item.kind !== kind) throw new AppError("NOT_FOUND", 404);
    await this.authority.meeting(actor, item.meetingId);
    return item;
  }
  private async view(
    actor: Actor,
    item: AcceptedItem,
    cache?: Map<string, Promise<EvidenceProof>>,
    recheckMeeting = true,
  ) {
    let evidenceStatus: "current" | "changed" | "unavailable" = "current";
    try {
      const citationRefs = item.citations.map(({ captureId, segmentId, revision }) => ({
        captureId,
        segmentId,
        revision,
      }));
      const cacheKey = item.meetingId + ":" + JSON.stringify(citationRefs);
      let pending = cache?.get(cacheKey);
      if (!pending) {
        pending = this.evidence.validate(actor, item.meetingId, citationRefs);
        cache?.set(cacheKey, pending);
      }
      const proof = await pending;
      if (proof.fingerprint !== item.sourceFingerprint) evidenceStatus = "changed";
    } catch (error) {
      if (error instanceof AppError && [401, 403].includes(error.status)) throw error;
      evidenceStatus =
        error instanceof AppError && [404, 409].includes(error.status) ? "changed" : "unavailable";
    }
    if (recheckMeeting) await this.authority.meeting(actor, item.meetingId);
    return { ...item, evidenceStatus, humanReviewed: true as const };
  }
  async read(actor: Actor, itemId: string, kind: AcceptedKind) {
    return this.view(actor, await this.available(actor, itemId, kind));
  }
  async list(actor: Actor, kind: AcceptedKind, body: unknown, requireComplete = false) {
    this.user(actor);
    const input = z
      .object({ kind: z.enum(["meeting", "project", "customer", "workspace"]), id: id.nullable() })
      .strict()
      .refine((s) => (s.kind === "workspace" ? s.id === null : s.id !== null))
      .parse(body);
    const meetings = await this.authority.readable(actor, input);
    const rows = await this.store.list(
      actor.workspaceId,
      meetings,
      kind,
      requireComplete ? 101 : 100,
    );
    if (requireComplete && rows.length > 100) throw new AppError("REVIEW_SCOPE_TOO_LARGE", 409);
    const result = [],
      cache = new Map<string, Promise<EvidenceProof>>();
    for (let start = 0; start < rows.length; start += 8)
      result.push(
        ...(await Promise.all(
          rows.slice(start, start + 8).map((item) => this.view(actor, item, cache, false)),
        )),
      );
    const current = new Set(await this.authority.readable(actor, input));
    return result.filter((item) => current.has(item.meetingId));
  }
  async correct(actor: Actor, itemId: string, kind: AcceptedKind, key: string, body: unknown) {
    this.key(key);
    const input = correctionInput.parse(body),
      item = await this.available(actor, itemId, kind);
    const replay = await this.store.replay(actor, key, { type: "correct", itemId, kind, input });
    if (replay) {
      await this.owner(actor, replay.meetingId);
      return replay;
    }
    await this.owner(actor, item.meetingId, input.expectedMeetingVersion);
    await this.fields(actor, kind, input.content);
    const proof = await this.evidence.validate(actor, item.meetingId, input.content.citations);
    const current = await this.evidence.validate(actor, item.meetingId, input.content.citations);
    if (current.fingerprint !== proof.fingerprint)
      throw new AppError("SOURCE_EVIDENCE_CHANGED", 409);
    await this.owner(actor, item.meetingId, input.expectedMeetingVersion);
    return this.store.correct(actor, key, item, input, proof);
  }
  async status(actor: Actor, itemId: string, kind: AcceptedKind, key: string, body: unknown) {
    this.key(key);
    const input = z
        .object({
          expectedVersion: z.number().int().positive(),
          confirmed: z.literal(true),
          state:
            kind === "decision"
              ? z.enum(["accepted", "superseded"])
              : z.enum(["open", "completed", "cancelled"]),
        })
        .strict()
        .parse(body),
      item = await this.available(actor, itemId, kind);
    const replay = await this.store.replay(actor, key, { type: "status", itemId, kind, input });
    if (replay) {
      await this.owner(actor, replay.meetingId);
      return replay;
    }
    await this.owner(actor, item.meetingId);
    return this.store.status(actor, key, item, input);
  }
}
