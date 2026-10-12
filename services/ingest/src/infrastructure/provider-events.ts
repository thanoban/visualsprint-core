import { createHash } from "node:crypto";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import type { ProviderEvent } from "../domain/records.js";

const artifact = z.object({ id, metadata: z.object({ attempt_id: id }) });
const common = z.object({
  event: z.string().min(1).max(100),
  data: z.object({ bot: artifact, data: z.unknown() }).passthrough(),
});
function stableId(value: string) {
  // UUIDv5-shaped deterministic identity from artifact, speaker and utterance start.
  // It is a local segment ID, not a provider revision or a permission capability.
  const hash = createHash("sha1")
    .update("visualsprint:recall:utterance:v1:")
    .update(value)
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function providerEvent(payload: unknown): ProviderEvent {
  const envelope = common.parse(payload);
  const base = {
    attemptId: envelope.data.bot.metadata.attempt_id,
    providerId: envelope.data.bot.id,
  };
  if (envelope.event === "transcript.data") {
    const timestamp = z.object({ relative: z.number().finite().min(0).max(604800) });
    const parsed = z
      .object({
        data: z.object({
          words: z
            .array(
              z.object({
                text: z.string().max(1000),
                start_timestamp: timestamp,
                end_timestamp: timestamp.nullable(),
              }),
            )
            .min(1)
            .max(5000),
          participant: z.object({
            id: z.number().int().nonnegative(),
            name: z.string().max(500).nullable(),
          }),
        }),
        transcript: z.object({ id }),
      })
      .parse(envelope.data);
    const words = [...parsed.data.words].sort(
      (a, b) => a.start_timestamp.relative - b.start_timestamp.relative,
    );
    const startMs = Math.round(words[0]!.start_timestamp.relative * 1000);
    const endMs = Math.round(
      Math.max(
        ...words.map((word) => word.end_timestamp?.relative ?? word.start_timestamp.relative),
      ) * 1000,
    );
    const text = z
      .string()
      .trim()
      .min(1)
      .max(32000)
      .parse(words.map((word) => word.text).join(" "));
    return {
      kind: "transcript",
      ...base,
      segment: {
        id: stableId(
          [base.providerId, parsed.transcript.id, parsed.data.participant.id, startMs].join(":"),
        ),
        revision: 1,
        startMs,
        endMs: Math.max(startMs, endMs),
        text,
        speakerLabel: parsed.data.participant.name?.trim() || null,
        finalized: true,
      },
    };
  }
  if (envelope.event.startsWith("bot.")) {
    const data = z
      .object({
        code: z.string().min(1).max(100),
        sub_code: z.string().max(200).nullable(),
        updated_at: z.string().datetime(),
      })
      .parse(envelope.data.data);
    if (envelope.event !== `bot.${data.code}`) throw new Error("INCONSISTENT_PROVIDER_EVENT");
    return {
      kind: "status",
      ...base,
      code: data.code,
      subCode: data.sub_code,
      occurredAt: new Date(data.updated_at),
    };
  }
  return { kind: "ignored", ...base };
}
