import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import type { EvidenceSource } from "../application/ports.js";
import type { Evidence } from "../domain/export.js";
import { workspaceExportContext } from "../application/reviewed-context.js";
const meetingSchema = z.object({
  id,
  version: z.number().int().positive(),
  title: z.string().max(200),
  notes: z.string().max(32000),
});
const captureSchema = z
  .object({
    id,
    version: z.number().int().positive(),
    state: z.string().max(40),
    coverage: z.string().max(40),
  })
  .strict();
const manifestSchema = z
  .object({ meetingId: id, complete: z.literal(true), captures: z.array(captureSchema).max(100) })
  .strict()
  .refine(
    (value) => new Set(value.captures.map((capture) => capture.id)).size === value.captures.length,
    "Duplicate capture",
  );
const segmentSchema = z
  .object({
    id,
    revision: z.number().int().positive(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    text: z.string().max(32000),
    speakerLabel: z.string().max(200).nullable(),
  })
  .refine((segment) => segment.endMs >= segment.startMs);
const pageSchema = z.object({
  segments: z.array(segmentSchema).max(100),
  nextCursor: z.string().max(100).nullable(),
  totalSegments: z.number().int().nonnegative(),
});
const normalizeReviewed = (input: unknown) => {
  const context = workspaceExportContext.parse(input);
  context.decisions.sort((a, b) => a.id.localeCompare(b.id));
  context.commitments.sort((a, b) => a.id.localeCompare(b.id));
  context.agendas.sort((a, b) => a.id.localeCompare(b.id));
  return context;
};
const normalizeManifest = (input: unknown) => {
  const manifest = manifestSchema.parse(input);
  manifest.captures.sort((a, b) => a.id.localeCompare(b.id));
  return manifest;
};
export class HttpExportSources implements EvidenceSource {
  constructor(
    private readonly workspaceOrigin: string,
    private readonly ingestOrigin: string,
    private readonly key: CryptoKey,
    private readonly keyId: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    for (const origin of [workspaceOrigin, ingestOrigin]) {
      const u = new URL(origin);
      if (
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== "/" ||
        (u.protocol !== "https:" &&
          !(
            process.env.NODE_ENV !== "production" &&
            u.protocol === "http:" &&
            ["localhost", "127.0.0.1"].includes(u.hostname)
          ))
      )
        throw new Error("INVALID_SOURCE_ORIGIN");
    }
  }
  private async read(
    actor: Actor,
    audience: "workspace" | "ingest",
    suffix: string,
    signal?: AbortSignal,
    internal = false,
    maxBytes = 700000,
  ) {
    if (actor.operationGrantId || actor.sessionId.startsWith("operation:"))
      throw new AppError("FORBIDDEN", 403);
    const token = await serviceToken({
      caller: "reporting",
      audience,
      actor,
      privateKey: this.key,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await this.transport(
        new URL(
          `${internal ? "/internal" : "/api/v3"}/workspaces/${id.parse(actor.workspaceId)}${suffix}`,
          audience === "workspace" ? this.workspaceOrigin : this.ingestOrigin,
        ),
        {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(4000)])
            : AbortSignal.timeout(4000),
        },
      );
    } catch {
      throw new AppError("EXPORT_SOURCE_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      if (response.status === 409) {
        const body = z
          .object({ code: z.string() })
          .safeParse(await boundedJson(response, 16000).catch(() => null));
        if (
          body.success &&
          [
            "EXPORT_CONTEXT_TOO_LARGE",
            "REVIEW_SCOPE_TOO_LARGE",
            "AGENDA_SCOPE_TOO_LARGE",
            "CAPTURE_EXPORT_SCOPE_TOO_LARGE",
          ].includes(body.data.code)
        )
          throw new Error("EXPORT_SIZE_LIMIT");
        throw new AppError("EXPORT_SOURCE_CHANGED", 503);
      }
      await response.body?.cancel();
      throw new AppError(
        "EXPORT_SOURCE_UNAVAILABLE",
        [401, 403, 404, 410].includes(response.status) ? response.status : 503,
      );
    }
    try {
      return await boundedJson(response, maxBytes);
    } catch (error) {
      if (error instanceof Error && error.message === "RESPONSE_BODY_TOO_LARGE")
        throw new Error("EXPORT_SIZE_LIMIT");
      throw error;
    }
  }
  async authorize(actor: Actor, meetingId: string) {
    try {
      const meeting = meetingSchema.parse(
        await this.read(actor, "workspace", `/meetings/${id.parse(meetingId)}`),
      );
      if (meeting.id !== meetingId) throw new AppError("EXPORT_SOURCE_UNAVAILABLE", 503);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("EXPORT_SOURCE_UNAVAILABLE", 503);
    }
  }
  async load(actor: Actor, meetingId: string): Promise<Evidence> {
    if (actor.operationGrantId || actor.sessionId.startsWith("operation:"))
      throw new AppError("FORBIDDEN", 403);
    const signal = AbortSignal.timeout(45000);
    try {
      const meeting = meetingSchema.parse(
        await this.read(actor, "workspace", `/meetings/${id.parse(meetingId)}`, signal),
      );
      if (meeting.id !== meetingId) throw new AppError("EXPORT_SOURCE_UNAVAILABLE", 503);
      const reviewed = normalizeReviewed(
        await this.read(
          actor,
          "workspace",
          `/meetings/${meetingId}/export-context`,
          signal,
          true,
          2000000,
        ),
      );
      if (reviewed.meetingId !== meetingId || reviewed.meetingVersion !== meeting.version)
        throw new AppError("EXPORT_SOURCE_CHANGED", 503);
      const manifest = normalizeManifest(
        await this.read(actor, "ingest", `/meetings/${meetingId}/export-captures`, signal, true),
      );
      if (manifest.meetingId !== meetingId) throw new AppError("EXPORT_SOURCE_UNAVAILABLE", 503);
      const captures = manifest.captures;
      if (captures.some((c) => !["complete", "partial", "failed", "cancelled"].includes(c.state)))
        throw new AppError("EXPORT_CAPTURE_NOT_FINAL", 503);
      const result: Evidence = {
        meetingId: meeting.id,
        version: meeting.version,
        title: meeting.title,
        notes: meeting.notes,
        reviewed,
        captures: [],
      };
      let count = 0,
        bytes =
          Buffer.byteLength(JSON.stringify(meeting)) + Buffer.byteLength(JSON.stringify(reviewed));
      if (bytes > 1500000) throw new Error("EXPORT_SIZE_LIMIT");
      for (const capture of captures) {
        const segments: Evidence["captures"][number]["segments"] = [];
        let cursor: string | null = null;
        let expectedTotal: number | undefined;
        const seen = new Set<string>(),
          ids = new Set<string>();
        do {
          const page = pageSchema.parse(
            await this.read(
              actor,
              "ingest",
              `/captures/${capture.id}/transcript${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
              signal,
            ),
          );
          expectedTotal ??= page.totalSegments;
          if (page.totalSegments !== expectedTotal)
            throw new AppError("EXPORT_SOURCE_CHANGED", 503);
          for (const segment of page.segments) {
            if (ids.has(segment.id)) throw new AppError("EXPORT_SOURCE_UNAVAILABLE", 503);
            ids.add(segment.id);
            bytes += Buffer.byteLength(JSON.stringify(segment));
            if (++count > 20000 || bytes > 1500000) throw new Error("EXPORT_SIZE_LIMIT");
            segments.push(segment);
          }
          cursor = page.nextCursor;
          if (cursor) {
            if (!page.segments.length || seen.has(cursor))
              throw new AppError("EXPORT_SOURCE_UNAVAILABLE", 503);
            seen.add(cursor);
          }
        } while (cursor);
        if (segments.length !== expectedTotal) throw new AppError("EXPORT_SOURCE_UNAVAILABLE", 503);
        result.captures.push({ ...capture, segments });
      }
      for (const record of [...reviewed.decisions, ...reviewed.commitments]) {
        if (record.evidenceStatus !== "current") continue;
        for (const reference of record.citations) {
          const capture = result.captures.find((value) => value.id === reference.captureId),
            segment = capture?.segments.find((value) => value.id === reference.segmentId);
          if (
            !capture ||
            capture.version !== reference.captureVersion ||
            !segment ||
            segment.revision !== reference.revision
          )
            throw new AppError("EXPORT_SOURCE_CHANGED", 503);
        }
      }
      const finalMeeting = meetingSchema.parse(
        await this.read(actor, "workspace", `/meetings/${meetingId}`, signal),
      );
      const finalReviewed = normalizeReviewed(
        await this.read(
          actor,
          "workspace",
          `/meetings/${meetingId}/export-context`,
          signal,
          true,
          2000000,
        ),
      );
      const finalManifest = normalizeManifest(
        await this.read(actor, "ingest", `/meetings/${meetingId}/export-captures`, signal, true),
      );
      if (
        JSON.stringify(finalMeeting) !== JSON.stringify(meeting) ||
        JSON.stringify(finalReviewed) !== JSON.stringify(reviewed) ||
        JSON.stringify(finalManifest) !== JSON.stringify(manifest)
      )
        throw new AppError("EXPORT_SOURCE_CHANGED", 503);
      return result;
    } catch (error) {
      if (
        error instanceof AppError ||
        (error instanceof Error && error.message === "EXPORT_SIZE_LIMIT")
      )
        throw error;
      throw new AppError("EXPORT_SOURCE_UNAVAILABLE", 503);
    }
  }
}
