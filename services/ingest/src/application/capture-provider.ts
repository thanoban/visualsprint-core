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
  }): Promise<DispatchResult>;
}
