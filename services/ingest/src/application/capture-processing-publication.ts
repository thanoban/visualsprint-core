import { randomBytes, randomUUID } from "node:crypto";
import { eventEnvelope, type DomainEvent } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { CaptureProcessingService, ProcessingBinding } from "./capture-processing.js";
export type CapturePublication = {
  workspaceId: string;
  captureId: string;
  meetingId: string;
  ownerId: string;
  consentId: string;
  consentVersion: number;
  transcriptRevision: number;
  policyVersion: "english-text-v1";
};
export interface CapturePublicationRepository {
  due(): Promise<{ workspaceId: string; captureId: string }[]>;
  candidate(workspaceId: string, captureId: string): Promise<CapturePublication | null>;
  commit(
    candidate: CapturePublication,
    decision: { event: DomainEvent } | { rejectionCode: string },
  ): Promise<void>;
  defer(workspaceId: string, captureId: string): Promise<void>;
}
export class CaptureProcessingPublisher {
  constructor(
    private readonly repository: CapturePublicationRepository,
    private readonly processing: Pick<CaptureProcessingService, "readyContext">,
  ) {}
  async work(workspaceId: string, captureId: string) {
    const candidate = await this.repository.candidate(workspaceId, captureId);
    if (!candidate) {
      await this.repository.defer(workspaceId, captureId);
      return;
    }
    const proof: ProcessingBinding = {
      consentId: candidate.consentId,
      expectedVersion: candidate.consentVersion,
      meetingId: candidate.meetingId,
      captureId: candidate.captureId,
      policyVersion: candidate.policyVersion,
    };
    const actor: Actor = {
      workspaceId: candidate.workspaceId,
      actorId: candidate.ownerId,
      operationGrantId: candidate.consentId,
      sessionId: `operation:${candidate.consentId}`,
    };
    try {
      await this.processing.readyContext(actor, captureId, {
        proof,
        transcriptRevision: candidate.transcriptRevision,
      });
    } catch (error) {
      if (error instanceof AppError && (error.status === 403 || error.code === "SOURCE_DELETED")) {
        await this.repository.commit(candidate, { rejectionCode: error.code });
        return;
      }
      await this.repository.defer(workspaceId, captureId);
      return;
    }
    const event = eventEnvelope.parse({
      eventId: randomUUID(),
      type: "capture.processing.ready.v1",
      schemaVersion: 1,
      workspaceId,
      aggregateId: captureId,
      aggregateVersion: candidate.transcriptRevision,
      occurredAt: new Date().toISOString(),
      traceId: randomBytes(16).toString("hex"),
      actorId: candidate.ownerId,
      references: [
        { kind: "meeting", id: candidate.meetingId },
        { kind: "capture", id: captureId, revision: candidate.transcriptRevision },
        { kind: "processing_consent", id: candidate.consentId, revision: candidate.consentVersion },
      ],
    });
    await this.repository.commit(candidate, { event });
  }
}
