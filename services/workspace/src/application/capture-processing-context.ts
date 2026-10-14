import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
export const processingContextInput = z
  .object({
    consentId: id,
    expectedVersion: z.number().int().positive(),
    meetingId: id,
    captureId: id,
    policyVersion: z.literal("english-text-v1"),
  })
  .strict();
export type ProcessingContextInput = z.infer<typeof processingContextInput>;
export const processingConsentProof = z
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
export interface ProcessingConsentAuthority {
  authorize(
    actor: Actor,
    input: ProcessingContextInput,
  ): Promise<z.infer<typeof processingConsentProof>>;
}
export interface ProcessingMeetings {
  metadata(
    actor: Actor,
    meetingId: string,
  ): Promise<{ id: string; ownerId: string; version: number; blocked: boolean } | undefined>;
}
export function requireProcessingActor(actor: Actor, input: ProcessingContextInput) {
  if (
    actor.operationGrantId !== input.consentId ||
    actor.sessionId !== `operation:${input.consentId}`
  )
    throw new AppError("FORBIDDEN", 403);
}
export class CaptureProcessingContext {
  constructor(
    private readonly meetings: ProcessingMeetings,
    private readonly consents: ProcessingConsentAuthority,
  ) {}
  private async authorize(actor: Actor, input: ProcessingContextInput) {
    const proof = processingConsentProof.parse(await this.consents.authorize(actor, input));
    if (
      proof.consentId !== input.consentId ||
      proof.workspaceId !== actor.workspaceId ||
      proof.ownerId !== actor.actorId ||
      proof.meetingId !== input.meetingId ||
      proof.captureId !== input.captureId ||
      proof.version !== input.expectedVersion ||
      proof.policyVersion !== input.policyVersion
    )
      throw new AppError("FORBIDDEN", 403);
  }
  private async meeting(actor: Actor, id: string) {
    const meeting = await this.meetings.metadata(actor, id);
    if (!meeting || meeting.id !== id || meeting.blocked || meeting.ownerId !== actor.actorId)
      throw new AppError("NOT_FOUND", 404);
    return meeting;
  }
  async read(actor: Actor, body: unknown) {
    const input = processingContextInput.parse(body);
    requireProcessingActor(actor, input);
    await this.authorize(actor, input);
    const before = await this.meeting(actor, input.meetingId);
    await this.authorize(actor, input);
    const after = await this.meeting(actor, input.meetingId);
    if (before.id !== after.id || before.version !== after.version)
      throw new AppError("PROCESSING_CONTEXT_CHANGED", 409);
    return { meetingId: after.id, ownerId: after.ownerId, meetingVersion: after.version };
  }
}
