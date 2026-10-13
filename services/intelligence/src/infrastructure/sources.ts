import { z } from "zod";
import { id, captureState } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type { Sources } from "../application/ports.js";
import type { Evidence, Scope, Snapshot } from "../domain/evidence.js";

const context = z.object({
  meetings: z
    .array(
      z.object({
        id,
        version: z.number().int().positive(),
        title: z.string().max(200),
        notes: z.string().max(32000),
      }),
    )
    .max(100),
});
const capture = z.object({
  id,
  meetingId: id,
  version: z.number().int().positive(),
  state: captureState,
  coverage: z.enum(["no_detected_gaps", "known_gaps", "unknown"]),
  createdAt: z.string().datetime(),
});
const segment = z.object({
  id,
  revision: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().min(1).max(32000),
  speakerLabel: z.string().max(200).nullable(),
  finalized: z.boolean(),
});
const page = z.object({
  captureId: id,
  coverage: z.enum(["no_detected_gaps", "known_gaps", "unknown"]),
  totalSegments: z.number().int().min(0).max(10000),
  segments: z.array(segment).max(100),
  nextCursor: z.string().max(100).nullable(),
});
export function internalOrigin(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new Error("INVALID_INTERNAL_ORIGIN");
  return url.origin;
}
export class AuthorizedSources implements Sources {
  private readonly origins: { workspace: string; ingest: string; account: string };
  constructor(
    origins: { workspace: string; ingest: string; account: string },
    private readonly privateKey: CryptoKey,
    private readonly keyId: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.origins = {
      workspace: internalOrigin(origins.workspace),
      ingest: internalOrigin(origins.ingest),
      account: internalOrigin(origins.account),
    };
  }
  private async readApi(
    actor: Actor,
    audience: "workspace" | "ingest" | "account",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await serviceToken({
      caller: "intelligence",
      audience,
      actor,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.origins[audience]), {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AppError("SOURCE_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404].includes(response.status)
          ? "SOURCE_FORBIDDEN"
          : response.status === 409
            ? "SOURCE_CHANGED"
            : "SOURCE_UNAVAILABLE",
        [401, 403, 404].includes(response.status) ? 403 : response.status === 409 ? 409 : 503,
      );
    }
    try {
      return await boundedJson(response, 4_000_000);
    } catch {
      throw new AppError("SOURCE_UNAVAILABLE", 503);
    }
  }
  async requireActive(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    try {
      z.object({ active: z.literal(true) }).parse(
        await this.readApi(
          actor,
          "account",
          `/internal/workspaces/${actor.workspaceId}/membership`,
          { userId: actor.actorId },
        ),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("SOURCE_UNAVAILABLE", 503);
    }
  }
  async read(actor: Actor, scope: Scope): Promise<Snapshot> {
    const deadline = Date.now() + 60_000;
    await this.requireActive(actor);
    let meetings: z.infer<typeof context>["meetings"];
    try {
      meetings = context.parse(
        await this.readApi(
          actor,
          "workspace",
          `/internal/workspaces/${actor.workspaceId}/intelligence-context`,
          { scope },
        ),
      ).meetings;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("SOURCE_UNAVAILABLE", 503);
    }
    if (new Set(meetings.map((row) => row.id)).size !== meetings.length)
      throw new AppError("SOURCE_UNAVAILABLE", 503);
    const versions: Snapshot["versions"] = [];
    const evidence: Evidence[] = [];
    let bytes = 0;
    // Bound parallel fetch pressure: batches of four meetings, with deterministic
    // merge order. Full source revisions are retained for cache invalidation.
    for (let offset = 0; offset < meetings.length; offset += 4) {
      if (Date.now() > deadline) throw new AppError("SOURCE_READ_TIMEOUT", 503);
      const results = await Promise.all(
        meetings.slice(offset, offset + 4).map(async (meeting) => {
          let captures: z.infer<typeof capture>[];
          try {
            captures = z
              .array(capture)
              .max(100)
              .parse(
                await this.readApi(
                  actor,
                  "ingest",
                  `/api/v3/workspaces/${actor.workspaceId}/meetings/${meeting.id}/captures`,
                ),
              );
          } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError("SOURCE_UNAVAILABLE", 503);
          }
          if (captures.some((row) => row.meetingId !== meeting.id))
            throw new AppError("SOURCE_UNAVAILABLE", 503);
          const current = captures
            .filter((row) => ["complete", "partial"].includes(row.state))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
          if (!current)
            return {
              version: {
                meetingId: meeting.id,
                version: meeting.version,
                captureId: null,
                captureVersion: null,
                coverage: "unknown" as const,
              },
              rows: [],
            };
          const rows: Evidence[] = [];
          const seen = new Set<string>();
          const cursors = new Set<string>();
          let cursor: string | undefined;
          let total: number | undefined;
          for (let count = 0; count < 101; count++) {
            if (Date.now() > deadline) throw new AppError("SOURCE_READ_TIMEOUT", 503);
            const url = `/api/v3/workspaces/${actor.workspaceId}/captures/${current.id}/transcript${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
            let result: z.infer<typeof page>;
            try {
              result = page.parse(await this.readApi(actor, "ingest", url));
            } catch (error) {
              if (error instanceof AppError) throw error;
              throw new AppError("SOURCE_UNAVAILABLE", 503);
            }
            if (
              result.captureId !== current.id ||
              result.coverage !== current.coverage ||
              (total !== undefined && result.totalSegments !== total)
            )
              throw new AppError("SOURCE_CHANGED", 409);
            total = result.totalSegments;
            for (const row of result.segments) {
              if (seen.has(row.id) || !row.finalized || row.endMs < row.startMs)
                throw new AppError("SOURCE_CHANGED", 409);
              seen.add(row.id);
              rows.push({
                meetingId: meeting.id,
                captureId: current.id,
                segmentId: row.id,
                revision: row.revision,
                startMs: row.startMs,
                endMs: row.endMs,
                text: row.text,
                speakerLabel: row.speakerLabel,
              });
            }
            if (!result.nextCursor) break;
            if (!result.segments.length || cursors.has(result.nextCursor) || count === 100)
              throw new AppError("SOURCE_UNAVAILABLE", 503);
            cursors.add(result.nextCursor);
            cursor = result.nextCursor;
          }
          if (rows.length !== total) throw new AppError("SOURCE_CHANGED", 409);
          let after: z.infer<typeof capture>;
          try {
            after = capture.parse(
              await this.readApi(
                actor,
                "ingest",
                `/api/v3/workspaces/${actor.workspaceId}/captures/${current.id}`,
              ),
            );
          } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError("SOURCE_UNAVAILABLE", 503);
          }
          if (
            after.version !== current.version ||
            after.state !== current.state ||
            after.coverage !== current.coverage
          )
            throw new AppError("SOURCE_CHANGED", 409);
          return {
            version: {
              meetingId: meeting.id,
              version: meeting.version,
              captureId: current.id,
              captureVersion: current.version,
              coverage:
                current.coverage === "no_detected_gaps"
                  ? ("complete" as const)
                  : current.coverage === "known_gaps"
                    ? ("partial" as const)
                    : ("unknown" as const),
            },
            rows,
          };
        }),
      );
      for (const result of results) {
        versions.push(result.version);
        for (const row of result.rows) {
          bytes += Buffer.byteLength(row.text, "utf8");
          if (bytes > 2_000_000) throw new AppError("EVIDENCE_TOO_LARGE", 409);
          evidence.push(row);
        }
      }
    }
    return { versions, evidence };
  }
}
