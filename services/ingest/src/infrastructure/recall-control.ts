import { z } from "zod";
import { id } from "@visualsprint/contracts";
import type { ProviderSnapshot, ReconcileResult } from "../application/capture-provider.js";

const status = z.object({ code: z.string().min(1).max(100), created_at: z.string().datetime() });
const bot = z.object({
  id,
  metadata: z.object({ attempt_id: id }).optional(),
  status_changes: z.array(status).max(10000),
});
export class RecallControl {
  constructor(
    private readonly apiKey: string,
    private readonly region: "us-west-2" | "us-east-1" | "eu-central-1" | "ap-northeast-1",
    private readonly transport: typeof fetch = (input, init) => fetch(input, init),
  ) {
    if (!apiKey.trim()) throw new Error("MISSING_RECALL_API_KEY");
  }
  private url(path: string) {
    return new URL(path, `https://${this.region}.recall.ai`);
  }
  private async request(url: URL, method = "GET") {
    return this.transport(url, {
      method,
      headers: { Authorization: `Token ${this.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  }
  private snapshot(value: z.infer<typeof bot>): ProviderSnapshot {
    const latest = [...value.status_changes]
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .at(-1);
    return {
      providerId: value.id,
      status: latest?.code ?? "unknown",
      occurredAt: latest?.created_at ?? null,
    };
  }
  async findAttempt(attemptId: string): Promise<ReconcileResult> {
    id.parse(attemptId);
    try {
      const url = this.url("/api/v1/bot/");
      url.searchParams.set("metadata__attempt_id", attemptId);
      const response = await this.request(url);
      if (!response.ok) return { kind: "unknown" };
      const result = z
        .object({ results: z.array(bot).max(1000), next: z.string().nullable() })
        .parse(await response.json());
      // Do not follow a provider-supplied URL with credentials or silently choose one duplicate.
      if (
        result.next ||
        result.results.some((value) => value.metadata?.attempt_id !== attemptId) ||
        result.results.length > 1
      )
        return { kind: "unknown" };
      return result.results[0]
        ? { kind: "found", bot: this.snapshot(result.results[0]) }
        : { kind: "not_found" };
    } catch {
      return { kind: "unknown" };
    }
  }
  async inspect(providerId: string): Promise<ProviderSnapshot | null> {
    id.parse(providerId);
    try {
      const response = await this.request(this.url(`/api/v1/bot/${providerId}/`));
      if (!response.ok) return null;
      const result = bot.parse(await response.json());
      return result.id === providerId ? this.snapshot(result) : null;
    } catch {
      return null;
    }
  }
  async leave(providerId: string): Promise<"accepted" | "unknown"> {
    id.parse(providerId);
    try {
      const response = await this.request(
        this.url(`/api/v1/bot/${providerId}/leave_call/`),
        "POST",
      );
      // Accepted means removal requested, never that departure has been observed.
      return response.ok ? "accepted" : "unknown";
    } catch {
      return "unknown";
    }
  }
}
