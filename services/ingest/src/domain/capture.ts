import type { CaptureState } from "@visualsprint/contracts";

const transitions: Record<CaptureState, readonly CaptureState[]> = {
  scheduled: ["dispatching", "cancelled"],
  dispatching: ["dispatch_unknown", "joining", "failed", "stopping"],
  dispatch_unknown: ["joining", "capturing", "finalizing", "failed", "stopping"],
  joining: ["waiting_for_admission", "capturing", "stopping", "finalizing", "failed"],
  waiting_for_admission: ["capturing", "stopping", "finalizing", "failed"],
  capturing: ["stopping", "finalizing"],
  stopping: ["finalizing", "failed"],
  finalizing: ["complete", "partial", "failed"],
  complete: [], partial: [], failed: [], cancelled: [],
};

export function transitionCapture(current: CaptureState, next: CaptureState): CaptureState {
  if (current === next) return current;
  if (!transitions[current].includes(next)) throw new Error("INVALID_CAPTURE_TRANSITION");
  return next;
}

export type Coverage = "no_detected_gaps" | "known_gaps" | "unknown";

export function finalOutcome(input: {
  stopConfirmed: boolean;
  drainComplete: boolean;
  coverage: Coverage;
  finalSegmentCount: number;
  silenceConfirmed: boolean;
}): "complete" | "partial" | "failed" {
  if (!input.stopConfirmed || !input.drainComplete) throw new Error("FINALIZATION_NOT_READY");
  if (!Number.isInteger(input.finalSegmentCount) || input.finalSegmentCount < 0) {
    throw new Error("INVALID_SEGMENT_COUNT");
  }
  if (input.finalSegmentCount === 0 && !input.silenceConfirmed) return "failed";
  return input.coverage === "no_detected_gaps" ? "complete" : "partial";
}

export function shouldLeave(input: {
  explicitEnd: boolean;
  stopRequested: boolean;
  hostRemoved: boolean;
  nonBotParticipants: number | null;
  aloneSinceMs: number | null;
  nowMs: number;
}): boolean {
  if (input.explicitEnd || input.stopRequested || input.hostRemoved) return true;
  return input.nonBotParticipants === 0 && input.aloneSinceMs !== null
    && input.nowMs >= input.aloneSinceMs + 90_000;
}
