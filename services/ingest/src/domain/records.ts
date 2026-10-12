import type { CaptureState } from "@visualsprint/contracts";
import type { Coverage } from "./capture.js";

export type ProviderEvent =
  | {
      kind: "transcript";
      attemptId: string;
      providerId: string;
      segment: Omit<Segment, "workspaceId" | "requestId">;
    }
  | {
      kind: "status";
      attemptId: string;
      providerId: string;
      code: string;
      subCode: string | null;
      occurredAt: Date;
    }
  | { kind: "ignored"; attemptId: string; providerId: string };

export type Capture = {
  workspaceId: string;
  id: string;
  meetingId: string;
  ownerId: string;
  sessionId: string;
  operationGrantId: string | null;
  meetingVersion: number;
  joinUrl: string;
  maxSeconds: number;
  state: CaptureState;
  version: number;
  ready: boolean;
  quotaState: "pending" | "held" | "settled" | "released";
  coverage: Coverage;
  transcriptHealth: "unknown" | "receiving" | "paused" | "ended";
  errorCode: string | null;
  stopRequested: boolean;
  attemptId: string;
  providerId: string | null;
  dispatchAt: Date | null;
  departedAt: Date | null;
  providerDone: boolean;
  lastStatusAt: Date | null;
  lastTranscriptAt: Date | null;
  leaseUntil: Date | null;
  leaseToken: string | null;
  createdAt: Date;
};
export type Segment = {
  workspaceId: string;
  requestId: string;
  id: string;
  revision: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string | null;
  finalized: boolean;
};
