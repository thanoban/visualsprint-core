import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
export const captureConsentBinding = z
  .object({
    consentId: id,
    expectedVersion: z.number().int().positive(),
    meetingId: id,
    captureId: id,
    policyVersion: z.literal("english-text-v1"),
  })
  .strict();
export type ConsentBinding = z.infer<typeof captureConsentBinding>;
export type CaptureConsent = {
  consentId: string;
  workspaceId: string;
  ownerId: string;
  meetingId: string;
  captureId: string;
  version: number;
  policyVersion: "english-text-v1";
  active: boolean;
  createdAt: Date;
};
export interface CaptureOwnerContext {
  read(
    actor: Actor,
    captureId: string,
  ): Promise<{
    captureId: string;
    meetingId: string;
    ownerId: string;
    policyVersion: "english-text-v1";
    optedIn: true;
  }>;
}
export interface CaptureConsentRepository {
  requireCurrent(actor: Actor, session: boolean): Promise<void>;
  create(
    actor: Actor,
    key: string,
    input: { captureId: string; meetingId: string; policyVersion: "english-text-v1" },
  ): Promise<CaptureConsent>;
  authorize(actor: Actor, binding: ConsentBinding): Promise<CaptureConsent>;
  list(actor: Actor, captureId?: string): Promise<CaptureConsent[]>;
  revoke(
    actor: Actor,
    key: string,
    consentId: string,
    expectedVersion: number,
  ): Promise<CaptureConsent>;
  deleteMeeting(
    workspaceId: string,
    meetingId: string,
    deletionId: string,
    sourceVersion: number,
  ): Promise<void>;
  withdrawCapture(
    actor: Actor,
    input: { captureId: string; meetingId: string; policyVersion: "english-text-v1" },
  ): Promise<{
    captureId: string;
    meetingId: string;
    consentId: string | null;
    version: number | null;
    active: false;
    creationBlocked: true;
  }>;
}
const keySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
export class CaptureConsentService {
  constructor(
    private readonly repository: CaptureConsentRepository,
    private readonly captures: CaptureOwnerContext,
  ) {}
  private user(actor: Actor) {
    if (actor.operationGrantId || actor.sessionId.startsWith("operation:"))
      throw new AppError("FORBIDDEN", 403);
  }
  async create(actor: Actor, key: string, body: unknown) {
    this.user(actor);
    keySchema.parse(key);
    const input = z
      .object({
        captureId: id,
        consent: z.literal(true),
        policyVersion: z.literal("english-text-v1"),
      })
      .strict()
      .parse(body);
    await this.repository.requireCurrent(actor, true);
    const context = await this.captures.read(actor, input.captureId);
    if (
      context.ownerId !== actor.actorId ||
      context.captureId !== input.captureId ||
      !context.optedIn ||
      context.policyVersion !== input.policyVersion
    )
      throw new AppError("CAPTURE_PROCESSING_OWNER_MISMATCH", 403);
    const current = await this.captures.read(actor, input.captureId);
    if (
      current.meetingId !== context.meetingId ||
      current.ownerId !== context.ownerId ||
      current.captureId !== context.captureId ||
      current.policyVersion !== context.policyVersion ||
      !current.optedIn
    )
      throw new AppError("CAPTURE_PROCESSING_CONTEXT_CHANGED", 409);
    return this.repository.create(actor, key, {
      captureId: context.captureId,
      meetingId: context.meetingId,
      policyVersion: input.policyVersion,
    });
  }
  async authorize(actor: Actor, body: unknown) {
    const binding = captureConsentBinding.parse(body);
    if (
      actor.operationGrantId !== binding.consentId ||
      actor.sessionId !== `operation:${binding.consentId}`
    )
      throw new AppError("FORBIDDEN", 403);
    const grant = await this.repository.authorize(actor, binding);
    return {
      consentId: grant.consentId,
      workspaceId: grant.workspaceId,
      ownerId: grant.ownerId,
      meetingId: grant.meetingId,
      captureId: grant.captureId,
      version: grant.version,
      policyVersion: grant.policyVersion,
      active: true as const,
    };
  }
  async list(actor: Actor, captureId?: string) {
    this.user(actor);
    if (captureId) id.parse(captureId);
    return { consents: await this.repository.list(actor, captureId) };
  }
  async revoke(actor: Actor, key: string, consentId: string, body: unknown) {
    this.user(actor);
    keySchema.parse(key);
    const input = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(body);
    return this.repository.revoke(actor, key, id.parse(consentId), input.expectedVersion);
  }
  async cleanup(workspaceId: string, deletionId: string, body: unknown) {
    const input = z
      .object({ meetingId: id, sourceVersion: z.number().int().positive() })
      .strict()
      .parse(body);
    await this.repository.deleteMeeting(
      id.parse(workspaceId),
      input.meetingId,
      id.parse(deletionId),
      input.sourceVersion,
    );
    return { deletionId, meetingId: input.meetingId, state: "complete" as const };
  }
  async withdrawalCleanup(actor: Actor, body: unknown) {
    // Pinned Ingest caller, after durable owner-approved withdrawal; cleanup only.
    const input = z
      .object({ captureId: id, meetingId: id, policyVersion: z.literal("english-text-v1") })
      .strict()
      .parse(body);
    return this.repository.withdrawCapture(actor, input);
  }
}
