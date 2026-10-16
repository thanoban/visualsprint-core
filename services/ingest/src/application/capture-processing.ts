import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
export const processingBinding = z
  .object({
    consentId: id,
    expectedVersion: z.number().int().positive(),
    meetingId: id,
    captureId: id,
    policyVersion: z.literal("english-text-v1"),
  })
  .strict();
export type ProcessingBinding = z.infer<typeof processingBinding>;
export type ProcessingIntent = {
  workspaceId: string;
  captureId: string;
  meetingId: string;
  ownerId: string;
  intentVersion: number;
  policyVersion: "english-text-v1";
  state: "consent_pending" | "ready" | "withdraw_requested" | "revoked" | "configuration_error";
  consentId: string | null;
  consentVersion: number | null;
  errorCode: string | null;
};
export type ProcessingCapture = {
  captureId: string;
  meetingId: string;
  ownerId: string;
  state: string;
  transcriptRevision: number;
  coverage: string;
  deleted: boolean;
};
export interface ProcessingRepository {
  capture(workspaceId: string, captureId: string): Promise<ProcessingCapture | null>;
  intent(workspaceId: string, captureId: string): Promise<ProcessingIntent | null>;
  create(actor: Actor, key: string, capture: ProcessingCapture): Promise<ProcessingIntent>;
  bind(
    intent: ProcessingIntent,
    grant: { consentId: string; version: number },
  ): Promise<ProcessingIntent>;
  withdraw(
    actor: Actor,
    key: string,
    captureId: string,
    expectedIntentVersion: number,
  ): Promise<ProcessingIntent>;
  page(
    workspaceId: string,
    captureId: string,
    cursor?: string,
  ): Promise<{
    segments: {
      id: string;
      revision: number;
      startMs: number;
      endMs: number;
      text: string;
      speakerLabel: string | null;
      finalized: boolean;
    }[];
    totalSegments: number;
    totalBytes: number;
    nextCursor: string | null;
  }>;
  finishWithdrawal(
    intent: ProcessingIntent,
    result: {
      captureId: string;
      meetingId: string;
      consentId: string | null;
      version: number | null;
      active: false;
      creationBlocked: true;
    },
  ): Promise<ProcessingIntent>;
  error(intent: ProcessingIntent, code: string): Promise<void>;
  hasMeetingIntents(workspaceId: string, meetingId: string): Promise<boolean>;
  deleteMeeting(
    workspaceId: string,
    meetingId: string,
    deletionId: string,
    sourceVersion: number,
  ): Promise<void>;
}
export interface ProcessingAuthority {
  owner(actor: Actor, meetingId: string): Promise<void>;
  grant(
    actor: Actor,
    binding: ProcessingBinding,
  ): Promise<{
    consentId: string;
    workspaceId: string;
    ownerId: string;
    meetingId: string;
    captureId: string;
    version: number;
    policyVersion: "english-text-v1";
    active: true;
  }>;
  workspace(
    actor: Actor,
    binding: ProcessingBinding,
  ): Promise<{ meetingId: string; ownerId: string; meetingVersion: number }>;
  create(
    actor: Actor,
    captureId: string,
  ): Promise<{
    consentId: string;
    version: number;
    workspaceId: string;
    ownerId: string;
    meetingId: string;
    captureId: string;
    policyVersion: "english-text-v1";
    active: true;
  }>;
  withdraw(
    actor: Actor,
    intent: ProcessingIntent,
  ): Promise<{
    captureId: string;
    meetingId: string;
    consentId: string | null;
    version: number | null;
    active: false;
    creationBlocked: true;
  }>;
  cleanup(
    workspaceId: string,
    meetingId: string,
    deletionId: string,
    sourceVersion: number,
  ): Promise<void>;
}
const commandKey = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
export class CaptureProcessingService {
  constructor(
    private readonly repository: ProcessingRepository,
    private readonly authority: ProcessingAuthority,
  ) {}
  async reconcileWithdrawal(actor: Actor, captureId: string) {
    const intent = await this.repository.intent(actor.workspaceId, captureId);
    if (intent?.state === "withdraw_requested") await this.reconcile(actor, captureId);
  }
  async prepare(actor: Actor, captureId: string) {
    const intent = await this.repository.intent(actor.workspaceId, captureId);
    if (!intent) return;
    if (intent.state === "withdraw_requested") {
      await this.reconcile(actor, captureId);
      return;
    }
    if (["consent_pending", "configuration_error"].includes(intent.state)) {
      await this.consent(actor, captureId, `processing:${captureId}:v1`, {
        consent: true,
        policyVersion: "english-text-v1",
      });
    }
  }
  async deleteMeeting(
    workspaceId: string,
    meetingId: string,
    deletionId: string,
    sourceVersion: number,
  ) {
    if (!(await this.repository.hasMeetingIntents(workspaceId, meetingId))) return;
    // Revoke the owning Account grant before acknowledging the existing Ingest
    // participant. Workspace already blocks access; no eighth participant needed.
    await this.authority.cleanup(workspaceId, meetingId, deletionId, sourceVersion);
    await this.repository.deleteMeeting(workspaceId, meetingId, deletionId, sourceVersion);
  }
  async status(actor: Actor, captureId: string) {
    const capture = await this.owned(actor, captureId),
      intent = await this.repository.intent(actor.workspaceId, captureId);
    return intent
      ? {
          state: intent.state,
          intentVersion: intent.intentVersion,
          consentId: intent.consentId,
          consentVersion: intent.consentVersion,
          policyVersion: intent.policyVersion,
          transcriptRevision: capture.transcriptRevision,
          errorCode: intent.errorCode,
        }
      : null;
  }
  private async owned(actor: Actor, captureId: string) {
    if (actor.operationGrantId || actor.sessionId.startsWith("operation:"))
      throw new AppError("FORBIDDEN", 403);
    const capture = await this.repository.capture(actor.workspaceId, id.parse(captureId));
    if (!capture || capture.deleted || capture.ownerId !== actor.actorId)
      throw new AppError("NOT_FOUND", 404);
    await this.authority.owner(actor, capture.meetingId);
    return capture;
  }
  async ownerContext(actor: Actor, captureId: string) {
    const capture = await this.owned(actor, captureId),
      intent = await this.repository.intent(actor.workspaceId, captureId);
    if (
      !intent ||
      !["consent_pending", "configuration_error", "ready"].includes(intent.state) ||
      intent.ownerId !== actor.actorId
    )
      throw new AppError("PROCESSING_NOT_OPTED_IN", 403);
    await this.authority.owner(actor, capture.meetingId);
    const current = await this.repository.intent(actor.workspaceId, captureId);
    if (
      !current ||
      current.intentVersion !== intent.intentVersion ||
      current.state !== intent.state
    )
      throw new AppError("PROCESSING_CONTEXT_CHANGED", 409);
    return {
      captureId,
      meetingId: capture.meetingId,
      ownerId: actor.actorId,
      policyVersion: "english-text-v1" as const,
      optedIn: true as const,
    };
  }
  async consent(actor: Actor, captureId: string, key: string, body: unknown) {
    commandKey.parse(key);
    z.object({ consent: z.literal(true), policyVersion: z.literal("english-text-v1") })
      .strict()
      .parse(body);
    const capture = await this.owned(actor, captureId),
      intent = await this.repository.create(actor, key, capture);
    if (!["consent_pending", "configuration_error"].includes(intent.state)) return intent;
    let grant: Awaited<ReturnType<ProcessingAuthority["create"]>>;
    try {
      grant = await this.authority.create(actor, captureId);
    } catch (error) {
      await this.repository.error(
        intent,
        error instanceof AppError ? error.code : "PROCESSING_AUTHORITY_UNAVAILABLE",
      );
      return (await this.repository.intent(actor.workspaceId, captureId))!;
    }
    if (
      grant.workspaceId !== actor.workspaceId ||
      grant.ownerId !== actor.actorId ||
      grant.meetingId !== capture.meetingId ||
      grant.captureId !== captureId ||
      grant.policyVersion !== intent.policyVersion ||
      !grant.active
    )
      throw new AppError("CONSENT_BINDING_CONFLICT", 409);
    const bound = await this.repository.bind(intent, grant);
    return bound.state === "withdraw_requested" ? this.reconcile(actor, captureId) : bound;
  }
  async withdraw(actor: Actor, captureId: string, key: string, body: unknown) {
    commandKey.parse(key);
    const input = z
      .object({ expectedIntentVersion: z.number().int().positive() })
      .strict()
      .parse(body);
    await this.owned(actor, captureId);
    await this.repository.withdraw(actor, key, captureId, input.expectedIntentVersion);
    return this.reconcile(actor, captureId);
  }
  async reconcile(actor: Actor, captureId: string): Promise<ProcessingIntent> {
    const intent = await this.repository.intent(actor.workspaceId, captureId);
    if (!intent || intent.ownerId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
    if (intent.state !== "withdraw_requested") return intent;
    try {
      return await this.repository.finishWithdrawal(
        intent,
        await this.authority.withdraw(actor, intent),
      );
    } catch (error) {
      await this.repository.error(
        intent,
        error instanceof AppError ? error.code : "PROCESSING_WITHDRAWAL_UNKNOWN",
      );
      return (await this.repository.intent(actor.workspaceId, captureId))!;
    }
  }
  private async permitted(actor: Actor, binding: ProcessingBinding) {
    if (
      actor.operationGrantId !== binding.consentId ||
      actor.sessionId !== `operation:${binding.consentId}`
    )
      throw new AppError("FORBIDDEN", 403);
    const grant = await this.authority.grant(actor, binding);
    if (
      grant.workspaceId !== actor.workspaceId ||
      grant.ownerId !== actor.actorId ||
      grant.captureId !== binding.captureId ||
      grant.meetingId !== binding.meetingId ||
      grant.consentId !== binding.consentId ||
      grant.version !== binding.expectedVersion ||
      grant.policyVersion !== binding.policyVersion ||
      !grant.active
    )
      throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
    const workspace = await this.authority.workspace(actor, binding);
    if (workspace.meetingId !== binding.meetingId || workspace.ownerId !== actor.actorId)
      throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
    const capture = await this.repository.capture(actor.workspaceId, binding.captureId),
      intent = await this.repository.intent(actor.workspaceId, binding.captureId);
    if (
      !capture ||
      capture.deleted ||
      capture.ownerId !== actor.actorId ||
      capture.meetingId !== binding.meetingId ||
      !intent ||
      intent.state !== "ready" ||
      intent.consentId !== binding.consentId ||
      intent.consentVersion !== binding.expectedVersion
    )
      throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
    if (!["complete", "partial"].includes(capture.state) || capture.transcriptRevision < 1)
      throw new AppError("PROCESSING_NOT_FINAL", 409);
    return { capture, workspace };
  }
  async evidence(actor: Actor, captureId: string, body: unknown) {
    const input = z
      .object({
        proof: processingBinding,
        transcriptRevision: z.number().int().positive(),
        cursor: z.string().max(100).nullable().default(null),
      })
      .strict()
      .parse(body);
    if (input.proof.captureId !== id.parse(captureId))
      throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
    const before = await this.permitted(actor, input.proof);
    if (before.capture.transcriptRevision !== input.transcriptRevision)
      throw new AppError("PROCESSING_REVISION_CHANGED", 409);
    const page = await this.repository.page(
      actor.workspaceId,
      captureId,
      input.cursor ?? undefined,
    );
    if (
      page.totalSegments > 10000 ||
      page.totalBytes > 2_000_000 ||
      page.segments.reduce((sum, row) => sum + Buffer.byteLength(row.text, "utf8"), 0) >
        2_000_000 ||
      page.segments.some((row) => !row.finalized || row.endMs < row.startMs)
    )
      throw new AppError("PROCESSING_EVIDENCE_TOO_LARGE", 409);
    const after = await this.permitted(actor, input.proof);
    if (
      after.capture.transcriptRevision !== input.transcriptRevision ||
      after.capture.coverage !== before.capture.coverage ||
      after.workspace.meetingVersion !== before.workspace.meetingVersion
    )
      throw new AppError("PROCESSING_REVISION_CHANGED", 409);
    return {
      workspaceId: actor.workspaceId,
      captureId,
      meetingId: input.proof.meetingId,
      ownerId: actor.actorId,
      meetingVersion: after.workspace.meetingVersion,
      transcriptRevision: input.transcriptRevision,
      coverage: after.capture.coverage,
      ...page,
    };
  }
  async readyContext(actor: Actor, captureId: string, body: unknown) {
    const input = z
      .object({ proof: processingBinding, transcriptRevision: z.number().int().positive() })
      .strict()
      .parse(body);
    if (input.proof.captureId !== id.parse(captureId))
      throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
    const before = await this.permitted(actor, input.proof);
    const after = await this.permitted(actor, input.proof);
    if (
      before.capture.transcriptRevision !== input.transcriptRevision ||
      after.capture.transcriptRevision !== input.transcriptRevision ||
      before.capture.coverage !== after.capture.coverage ||
      before.workspace.meetingVersion !== after.workspace.meetingVersion
    )
      throw new AppError("PROCESSING_REVISION_CHANGED", 409);
    return {
      workspaceId: actor.workspaceId,
      captureId,
      meetingId: input.proof.meetingId,
      ownerId: actor.actorId,
      consentId: input.proof.consentId,
      consentVersion: input.proof.expectedVersion,
      policyVersion: input.proof.policyVersion,
      transcriptRevision: input.transcriptRevision,
      state: after.capture.state as "complete" | "partial",
      ready: true as const,
    };
  }
}
