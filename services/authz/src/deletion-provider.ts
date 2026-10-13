import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson } from "@visualsprint/platform";
import { safeOrigin } from "./policy.js";
import type { MeetingTuplePurge } from "./deletion-service.js";
const tuple = z.object({
  user: z.string().min(1).max(400),
  relation: z.string().regex(/^[a-z_]{1,40}$/),
  object: z.string().min(1).max(200),
});
export class OpenFgaMeetingPurge implements MeetingTuplePurge {
  private readonly origin: URL;
  constructor(
    origin: string,
    private readonly apiKey: string,
    private readonly storeId: string,
    private readonly modelId: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.origin = safeOrigin(origin);
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(storeId) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(modelId))
      throw new Error("INVALID_AUTHORIZATION_MODEL_ID");
  }
  private async call(path: "read" | "write", body: unknown, signal: AbortSignal) {
    let response: Response;
    try {
      response = await this.transport(new URL(`/stores/${this.storeId}/${path}`, this.origin), {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
        redirect: "error",
      });
    } catch {
      throw new AppError("AUTHZ_CLEANUP_PENDING", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError("AUTHZ_CLEANUP_PENDING", 503);
    }
    return response;
  }
  async remove(ws: string, meetingId: string) {
    const object = `meeting:${id.parse(ws)}/${id.parse(meetingId)}`,
      signal = AbortSignal.timeout(3000);
    for (let page = 0; page < 10; page++) {
      if (signal.aborted) throw new AppError("AUTHZ_CLEANUP_PENDING", 503);
      const response = await this.call(
        "read",
        { tuple_key: { object }, page_size: 100, consistency: "HIGHER_CONSISTENCY" },
        signal,
      );
      const found = z
        .object({
          tuples: z.array(z.object({ key: tuple })).max(100),
          continuation_token: z.string().max(4000).optional(),
        })
        .parse(await boundedJson(response, 64000));
      if (found.tuples.some((row) => row.key.object !== object))
        throw new AppError("AUTHZ_CLEANUP_SCOPE_MISMATCH", 503);
      if (!found.tuples.length) {
        if (found.continuation_token) throw new AppError("AUTHZ_CLEANUP_PENDING", 503);
        return;
      }
      const removed = await this.call(
        "write",
        {
          deletes: { tuple_keys: found.tuples.map((row) => row.key) },
          authorization_model_id: this.modelId,
        },
        signal,
      );
      await removed.body?.cancel(); /* Read from the first page after deletes: continuation tokens can skip shifted rows. */
    }
    throw new AppError("AUTHZ_CLEANUP_PENDING", 503);
  }
}
