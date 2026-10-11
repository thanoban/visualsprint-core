import { id } from "@visualsprint/contracts";
import type { CaptureProvider, DispatchResult } from "../application/capture-provider.js";
import { parseMeetingLink } from "../domain/meeting-url.js";

export function buildRecallRequest(input: {
  meetingUrl: string;
  attemptId: string;
  transcriptWebhookUrl: string;
}) {
  const meeting = parseMeetingLink(input.meetingUrl);
  const webhook = new URL(input.transcriptWebhookUrl);
  if (webhook.protocol !== "https:" || webhook.username || webhook.password || webhook.hash) {
    throw new Error("INVALID_WEBHOOK_CONFIGURATION");
  }
  return {
    meeting_url: meeting.url,
    bot_name: "VisualSprint Notetaker",
    metadata: { attempt_id: id.parse(input.attemptId) },
    recording_config: {
      retention: null,
      video_mixed_mp4: null,
      audio_mixed_mp3: null,
      transcript: {
        provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } },
      },
      realtime_endpoints: [{
        type: "webhook",
        url: webhook.href,
        events: ["transcript.data"],
      }],
    },
  };
}

export class RecallProvider implements CaptureProvider {
  constructor(
    private readonly apiKey: string,
    private readonly region: "us-west-2" | "us-east-1" | "eu-central-1" | "ap-northeast-1",
    private readonly transport: typeof fetch = fetch,
  ) {
    if (!apiKey.trim()) throw new Error("MISSING_RECALL_API_KEY");
  }

  async create(input: Parameters<CaptureProvider["create"]>[0]): Promise<DispatchResult> {
    const body = buildRecallRequest(input);
    try {
      const response = await this.transport(`https://${this.region}.recall.ai/api/v1/bot/`, {
        method: "POST",
        headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 429 || response.status === 507) {
        return { kind: "capacity", retryAfterSeconds: 30 };
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: "rejected", code: "AUTHENTICATION" };
      }
      if (response.status === 400 || response.status === 422) {
        return { kind: "rejected", code: "INVALID_REQUEST" };
      }
      if (!response.ok) return { kind: "unknown" };
      const result: unknown = await response.json();
      const providerId = id.safeParse(
        typeof result === "object" && result !== null && "id" in result ? result.id : undefined,
      );
      return providerId.success ? { kind: "accepted", providerId: providerId.data } : { kind: "unknown" };
    } catch {
      // A timeout may follow provider acceptance. The caller must reconcile the
      // persisted attempt; this adapter never blindly resends a create request.
      return { kind: "unknown" };
    }
  }
}
