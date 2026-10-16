import type { Actor } from "@visualsprint/platform";
import type { DomainEvent } from "@visualsprint/contracts";
import type { Capture, Segment } from "../domain/records.js";
export type { Capture, Segment } from "../domain/records.js";
export type CaptureContext = {
  meetingId: string;
  ownerId: string;
  joinUrl: string;
  version: number;
};
export interface MeetingAuthority {
  capture(actor: Actor, meetingId: string): Promise<CaptureContext>;
  read(actor: Actor, meetingId: string): Promise<void>;
  manage(actor: Actor, meetingId: string): Promise<void>;
}
export interface UsageAuthority {
  lookup(
    actor: Actor,
    requestId: string,
  ): Promise<{ state: "held" | "settled" | "released"; maxSeconds: number } | null>;
  reserve(
    actor: Actor,
    requestId: string,
    maxSeconds: number,
  ): Promise<"held" | "settled" | "released">;
  release(actor: Actor, requestId: string): Promise<void>;
  settle(actor: Actor, requestId: string, seconds: number): Promise<void>;
}
export interface CaptureTransaction {
  processingDispatchAllowed(requestId: string): Promise<boolean>;
  deleteMeeting(meetingId: string, deletionId: string, sourceVersion: number): Promise<boolean>;
  calendarCommand(actor: Actor, key: string, cancel: boolean): Promise<Capture | undefined>;
  load(requestId: string): Promise<Capture | undefined>;
  list(meetingId: string): Promise<Capture[]>;
  exportCaptures(
    meetingId: string,
  ): Promise<Pick<Capture, "id" | "version" | "state" | "coverage">[]>;
  command(
    actor: Actor,
    key: string,
    fingerprint: string,
    create: () => Promise<Capture>,
  ): Promise<Capture>;
  insert(input: {
    actor: Actor;
    context: CaptureContext;
    maxSeconds: number;
    dispatchNotBefore?: Date;
    processing?: boolean;
  }): Promise<Capture>;
  update(
    requestId: string,
    changes: Partial<
      Pick<
        Capture,
        | "state"
        | "ready"
        | "quotaState"
        | "coverage"
        | "transcriptHealth"
        | "errorCode"
        | "stopRequested"
        | "providerId"
        | "dispatchAt"
        | "departedAt"
        | "providerDone"
        | "lastStatusAt"
        | "lastTranscriptAt"
        | "leaseUntil"
        | "leaseToken"
      >
    >,
  ): Promise<Capture>;
  emit(
    capture: Capture,
    type: DomainEvent["type"],
    references?: DomainEvent["references"],
  ): Promise<void>;
  acceptMessage(source: string, messageId: string, digest: string): Promise<boolean>;
  storeSegment(
    requestId: string,
    segment: Omit<Segment, "workspaceId" | "requestId">,
  ): Promise<boolean>;
  transcript(requestId: string, cursor?: { startMs: number; id: string }): Promise<Segment[]>;
  segmentCount(requestId: string): Promise<number>;
  evidence(requestId: string, segmentIds: string[]): Promise<Segment[]>;
}
export interface CaptureRepository {
  scoped<T>(workspaceId: string, work: (tx: CaptureTransaction) => Promise<T>): Promise<T>;
  attempt<T>(
    attemptId: string,
    work: (tx: CaptureTransaction, requestId: string) => Promise<T>,
  ): Promise<T>;
}
