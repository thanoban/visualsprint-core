export type DispatchResult =
  | { kind: "accepted"; providerId: string }
  | { kind: "capacity"; retryAfterSeconds: number }
  | { kind: "rejected"; code: "AUTHENTICATION" | "INVALID_REQUEST" }
  | { kind: "unknown" };

export interface CaptureProvider {
  create(input: {
    meetingUrl: string;
    attemptId: string;
    transcriptWebhookUrl: string;
    maxDurationSeconds?: number;
  }): Promise<DispatchResult>;
}
export type ProviderSnapshot = { providerId: string; status: string; occurredAt: string | null };
export type ReconcileResult =
  | { kind: "found"; bot: ProviderSnapshot }
  | { kind: "not_found" }
  | { kind: "unknown" };
export interface ManagedCaptureProvider extends CaptureProvider {
  findAttempt(attemptId: string): Promise<ReconcileResult>;
  inspect(providerId: string): Promise<ProviderSnapshot | null>;
  leave(providerId: string): Promise<"accepted" | "unknown">;
}
