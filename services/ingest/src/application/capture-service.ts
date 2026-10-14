import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { id, type CaptureState } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { Capture, CaptureRepository, MeetingAuthority, UsageAuthority } from "./ports.js";
import type { ManagedCaptureProvider } from "./capture-provider.js";
import { finalOutcome } from "../domain/capture.js";
import { parseMeetingLink } from "../domain/meeting-url.js";
import type { ProviderEvent } from "../domain/records.js";

const terminal = new Set<CaptureState>(["complete", "partial", "failed", "cancelled"]);
const commandKey = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const captureInput = z
  .object({
    meetingId: id,
    expectedMeetingVersion: z.number().int().positive(),
    maxDurationSeconds: z.number().int().min(1).max(14400).default(14400),
    startsAt: z.string().datetime().optional(),
    processing: z
      .object({ consent: z.literal(true), policyVersion: z.literal("english-text-v1") })
      .strict()
      .optional(),
  })
  .strict();
export function captureView(record: Capture) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    meetingId: record.meetingId,
    ownerId: record.ownerId,
    state: record.state,
    version: record.version,
    ready: record.ready,
    coverage: record.coverage,
    transcriptHealth: record.transcriptHealth,
    errorCode: record.errorCode,
    stopRequested: record.stopRequested,
    createdAt: record.createdAt,
    maxDurationSeconds: record.maxSeconds,
    dispatchNotBefore: record.dispatchNotBefore,
  };
}
const actorFor = (record: Capture): Actor => ({
  actorId: record.ownerId,
  workspaceId: record.workspaceId,
  sessionId: record.sessionId,
  ...(record.operationGrantId ? { operationGrantId: record.operationGrantId } : {}),
});
export class CaptureService {
  constructor(
    private readonly repository: CaptureRepository,
    private readonly meetings: MeetingAuthority,
    private readonly usage: UsageAuthority,
    private readonly provider: ManagedCaptureProvider,
    private readonly webhookUrl: string,
    private readonly now: () => Date = () => new Date(),
    private readonly processing?: {
      enabled?: boolean;
      prepare(actor: Actor, captureId: string): Promise<void>;
      deleteMeeting(
        workspaceId: string,
        meetingId: string,
        deletionId: string,
        sourceVersion: number,
      ): Promise<void>;
    },
  ) {}
  async request(actor: Actor, key: string, body: unknown) {
    commandKey.parse(key);
    const input = captureInput.parse(body);
    if (
      input.processing &&
      (actor.operationGrantId || !this.processing || this.processing.enabled === false)
    )
      throw new AppError(
        actor.operationGrantId ? "FORBIDDEN" : "CAPTURE_PROCESSING_NOT_CONFIGURED",
        actor.operationGrantId ? 403 : 503,
      );
    const startsAt = input.startsAt ? new Date(input.startsAt) : null;
    const dispatchNotBefore = startsAt ? new Date(startsAt.getTime() - 60000) : this.now();
    const context = await this.meetings.capture(actor, input.meetingId);
    parseMeetingLink(context.joinUrl);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const record = await this.repository.scoped(actor.workspaceId, (tx) =>
      tx.command(actor, key, fingerprint, async () => {
        if (
          startsAt &&
          (startsAt.getTime() < this.now().getTime() - 300000 ||
            startsAt.getTime() > this.now().getTime() + 14 * 86400000)
        )
          throw new AppError("INVALID_CAPTURE_TIME", 400);
        if (context.version !== input.expectedMeetingVersion)
          throw new AppError("VERSION_CONFLICT", 409);
        return tx.insert({
          actor,
          context,
          maxSeconds: input.maxDurationSeconds,
          dispatchNotBefore,
          ...(input.processing ? { processing: true } : {}),
        });
      }),
    );
    if (record.ready || terminal.has(record.state)) return captureView(record);
    if (this.processing) await this.processing.prepare(actor, record.id);
    if (
      !(await this.repository.scoped(actor.workspaceId, (tx) =>
        tx.processingDispatchAllowed(record.id),
      ))
    )
      return captureView(record);
    if (this.now() < record.dispatchNotBefore) return captureView(record);
    let reservation: Awaited<ReturnType<UsageAuthority["reserve"]>>;
    try {
      reservation = await this.usage.reserve(actor, record.id, record.maxSeconds);
    } catch (error) {
      if (error instanceof AppError && [401, 402, 403, 429].includes(error.status)) {
        await this.repository.scoped(actor.workspaceId, async (tx) => {
          const current = await tx.load(record.id);
          if (current && current.quotaState === "pending" && current.state === "scheduled") {
            const failed = await tx.update(record.id, { state: "failed", errorCode: error.code });
            await tx.emit(failed, "capture.state.changed.v1");
          }
        });
      }
      throw error;
    }
    return this.repository.scoped(actor.workspaceId, async (tx) => {
      const current = await tx.load(record.id);
      if (!current) throw new AppError("NOT_FOUND", 404);
      if (current.ready) return captureView(current);
      if (reservation !== "held") throw new AppError("RESERVATION_CONFLICT", 409);
      const updated = await tx.update(record.id, {
        quotaState: "held",
        ready: !terminal.has(current.state),
      });
      await tx.emit(
        updated,
        current.state === "scheduled" ? "capture.requested.v1" : "capture.state.changed.v1",
      );
      return captureView(updated);
    });
  }
  async status(actor: Actor, requestId: string) {
    const record = await this.repository.scoped(actor.workspaceId, (tx) =>
      tx.load(id.parse(requestId)),
    );
    if (!record) throw new AppError("NOT_FOUND", 404);
    await this.meetings.read(actor, record.meetingId);
    return captureView(record);
  }
  async calendarCommand(actor: Actor, body: unknown) {
    const input = z.object({ key: commandKey, cancel: z.boolean() }).strict().parse(body);
    return this.repository.scoped(actor.workspaceId, async (tx) => {
      const record = await tx.calendarCommand(actor, input.key, input.cancel);
      if (!record) return { capture: null, fenced: input.cancel };
      if (!input.cancel || record.stopRequested || terminal.has(record.state))
        return { capture: captureView(record), fenced: input.cancel };
      const updated = await tx.update(record.id, {
        stopRequested: true,
        state:
          record.state === "scheduled"
            ? "cancelled"
            : record.state === "finalizing"
              ? "finalizing"
              : "stopping",
      });
      await tx.emit(updated, "capture.state.changed.v1");
      return { capture: captureView(updated), fenced: true };
    });
  }
  async deleteMeeting(workspaceId: string, deletionId: string, body: unknown) {
    const input = z
      .object({ meetingId: id, sourceVersion: z.number().int().positive() })
      .strict()
      .parse(body);
    const complete = await this.repository.scoped(id.parse(workspaceId), (tx) =>
      tx.deleteMeeting(input.meetingId, id.parse(deletionId), input.sourceVersion),
    );
    await this.processing?.deleteMeeting(
      workspaceId,
      input.meetingId,
      deletionId,
      input.sourceVersion,
    );
    return {
      deletionId,
      meetingId: input.meetingId,
      participant: "ingest",
      state: complete ? "complete" : "pending",
    };
  }
  async evidenceBatch(actor: Actor, body: unknown) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    const input = z
      .object({
        meetingId: id,
        citations: z
          .array(
            z
              .object({ captureId: id, segmentId: id, revision: z.number().int().positive() })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict()
      .parse(body);
    await this.meetings.read(actor, input.meetingId);
    const segments = await this.repository.scoped(actor.workspaceId, async (tx) => {
      const rows = [];
      for (const captureId of [...new Set(input.citations.map((c) => c.captureId))].sort()) {
        const capture = await tx.load(captureId);
        if (
          !capture ||
          capture.meetingId !== input.meetingId ||
          !["complete", "partial"].includes(capture.state)
        )
          throw new AppError("EVIDENCE_NOT_FINAL", 409);
        const requested = input.citations.filter((c) => c.captureId === captureId);
        const evidence = await tx.evidence(
          captureId,
          requested.map((c) => c.segmentId),
        );
        for (const citation of requested) {
          const segment = evidence.find(
            (s) => s.id === citation.segmentId && s.revision === citation.revision && s.finalized,
          );
          if (!segment) throw new AppError("EVIDENCE_REVISION_CHANGED", 409);
          rows.push({
            captureId,
            captureVersion: capture.version,
            state: capture.state,
            coverage: capture.coverage,
            segmentId: segment.id,
            revision: segment.revision,
            text: segment.text,
            finalized: segment.finalized,
            startMs: segment.startMs,
            endMs: segment.endMs,
            speakerLabel: segment.speakerLabel,
          });
        }
      }
      return rows;
    });
    await this.meetings.read(actor, input.meetingId);
    return { meetingId: input.meetingId, segments };
  }
  async list(actor: Actor, meetingId: string) {
    await this.meetings.read(actor, id.parse(meetingId));
    return (await this.repository.scoped(actor.workspaceId, (tx) => tx.list(meetingId))).map(
      captureView,
    );
  }
  async stop(actor: Actor, requestId: string) {
    const record = await this.repository.scoped(actor.workspaceId, (tx) =>
      tx.load(id.parse(requestId)),
    );
    if (!record) throw new AppError("NOT_FOUND", 404);
    await this.meetings.manage(actor, record.meetingId);
    return this.repository.scoped(actor.workspaceId, async (tx) => {
      const current = await tx.load(requestId);
      if (!current) throw new AppError("NOT_FOUND", 404);
      if (current.stopRequested || terminal.has(current.state)) return captureView(current);
      const updated = await tx.update(requestId, {
        stopRequested: true,
        state:
          current.state === "scheduled"
            ? "cancelled"
            : current.state === "finalizing"
              ? "finalizing"
              : "stopping",
      });
      await tx.emit(updated, "capture.state.changed.v1");
      return captureView(updated);
    });
  }
  async transcript(actor: Actor, requestId: string, cursor?: string) {
    const parsedCursor =
      cursor === undefined
        ? undefined
        : (() => {
            const parts = z
              .string()
              .max(100)
              .regex(/^[0-9]+:[0-9a-f-]+$/i)
              .parse(cursor)
              .split(":");
            return {
              startMs: z.number().int().min(0).max(604800000).parse(Number(parts[0])),
              id: id.parse(parts[1]),
            };
          })();
    const record = await this.repository.scoped(actor.workspaceId, (tx) =>
      tx.load(id.parse(requestId)),
    );
    if (!record) throw new AppError("NOT_FOUND", 404);
    await this.meetings.read(actor, record.meetingId);
    return this.repository.scoped(actor.workspaceId, async (tx) => {
      const rows = await tx.transcript(requestId, parsedCursor);
      const segments: typeof rows = [];
      let bytes = 0;
      for (const row of rows.slice(0, 100)) {
        const size = Buffer.byteLength(JSON.stringify(row), "utf8");
        if (segments.length && bytes + size > 600_000) break;
        segments.push(row);
        bytes += size;
      }
      const last = segments.at(-1);
      return {
        captureId: record.id,
        coverage: record.coverage,
        totalSegments: await tx.segmentCount(requestId),
        segments,
        nextCursor: rows.length > segments.length && last ? `${last.startMs}:${last.id}` : null,
      };
    });
  }
  async receive(source: string, messageId: string, digest: string, event: ProviderEvent) {
    return this.repository.attempt(event.attemptId, async (tx, requestId) => {
      const current = await tx.load(requestId);
      if (!current) throw new AppError("NOT_FOUND", 404);
      if (current.providerId && current.providerId !== event.providerId)
        throw new AppError("PROVIDER_ID_CONFLICT", 409);
      if (!(await tx.acceptMessage(source, messageId, digest))) return;
      if (event.kind === "ignored") return;
      if (event.kind === "transcript") {
        if (current.state === "cancelled" && !current.dispatchAt) return;
        // Final provider utterances are revision 1. Human revisions (2+) cannot be overwritten.
        if (await tx.storeSegment(requestId, event.segment)) {
          const updated = await tx.update(requestId, {
            providerId: event.providerId,
            lastTranscriptAt: this.now(),
            coverage: terminal.has(current.state) ? "known_gaps" : current.coverage,
            state: current.state === "complete" ? "partial" : current.state,
            transcriptHealth:
              terminal.has(current.state) || current.state === "finalizing" ? "ended" : "receiving",
          });
          await tx.emit(updated, "transcript.revision.changed.v1", [
            { kind: "capture", id: requestId },
            { kind: "transcript", id: event.segment.id, revision: event.segment.revision },
          ]);
        }
        return;
      }
      if (current.lastStatusAt && event.occurredAt < current.lastStatusAt) return;
      const departure = ["call_ended", "done", "fatal"].includes(event.code);
      if (terminal.has(current.state)) return;
      let state: CaptureState = current.state;
      let errorCode = current.errorCode;
      if (departure) state = "finalizing";
      else if (current.state !== "stopping" && current.state !== "finalizing") {
        if (event.code === "in_call_recording") state = "capturing";
        else if (event.code === "in_waiting_room" && current.state !== "capturing")
          state = "waiting_for_admission";
        else if (
          event.code === "joining_call" &&
          ["scheduled", "dispatching", "dispatch_unknown"].includes(current.state)
        )
          state = "joining";
      }
      if (event.subCode === "bot_kicked_from_call") errorCode = "HOST_REMOVED";
      if (
        [
          "bot_kicked_from_waiting_room",
          "timeout_exceeded_waiting_room",
          "zoom_local_recording_request_denied_by_host",
        ].includes(event.subCode ?? "") ||
        event.code === "recording_permission_denied"
      )
        errorCode = "HOST_DENIED";
      if (
        [
          "meeting_not_accessible",
          "meeting_requires_sign_in",
          "zoom_sdk_key_blocked_by_host_admin",
        ].includes(event.subCode ?? "")
      )
        errorCode = "POLICY_BLOCKED";
      if (event.code === "fatal" && !errorCode) errorCode = "PROVIDER_UNAVAILABLE";
      const updated = await tx.update(requestId, {
        state,
        errorCode,
        providerId: event.providerId,
        lastStatusAt: event.occurredAt,
        departedAt: departure ? (current.departedAt ?? event.occurredAt) : current.departedAt,
        providerDone: current.providerDone || event.code === "done" || event.code === "fatal",
        transcriptHealth: departure
          ? "ended"
          : event.code === "in_call_not_recording" || event.code === "recording_permission_denied"
            ? "paused"
            : current.transcriptHealth,
        coverage: event.code === "fatal" ? "known_gaps" : current.coverage,
      });
      await tx.emit(updated, "capture.state.changed.v1");
    });
  }
  async work(workspaceId: string, requestId: string) {
    const pending = await this.repository.scoped(workspaceId, (tx) => tx.load(requestId));
    if (pending?.state === "scheduled" && this.now() < pending.dispatchNotBefore) return;
    if (pending?.state === "scheduled" && !pending.stopRequested) {
      if (this.processing) await this.processing.prepare(actorFor(pending), pending.id);
      if (
        !(await this.repository.scoped(workspaceId, (tx) =>
          tx.processingDispatchAllowed(pending.id),
        ))
      )
        return;
    }
    if (pending?.quotaState === "pending") await this.recoverAdmission(pending);
    if (pending?.state === "scheduled") {
      try {
        const context = await this.meetings.capture(actorFor(pending), pending.meetingId);
        if (context.ownerId !== pending.ownerId || context.joinUrl !== pending.joinUrl)
          throw new AppError("MEETING_CHANGED", 409);
      } catch (error) {
        if (!(error instanceof AppError) || ![400, 401, 403, 404, 409].includes(error.status))
          throw error;
        await this.repository.scoped(workspaceId, async (tx) => {
          const current = await tx.load(requestId);
          if (current?.state === "scheduled" && !current.dispatchAt) {
            const closed = await tx.update(requestId, {
              state: "cancelled",
              stopRequested: true,
              errorCode: error.code,
              providerDone: true,
            });
            await tx.emit(closed, "capture.state.changed.v1");
          }
        });
      }
    }
    const token = randomUUID();
    const now = this.now();
    const claim = await this.repository.scoped(workspaceId, async (tx) => {
      const record = await tx.load(requestId);
      if (!record || (record.leaseUntil && record.leaseUntil > now)) return null;
      if (record.state === "scheduled" && !(await tx.processingDispatchAllowed(record.id)))
        return null;
      if (!record.ready && !terminal.has(record.state)) return null;
      const first = record.state === "scheduled" && record.ready;
      const updated = await tx.update(requestId, {
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + 30_000),
        ...(first ? { state: "dispatching", dispatchAt: now } : {}),
      });
      return { record: updated, first };
    });
    if (!claim) return;
    try {
      let current = claim.record;
      const save = async (
        changes: Parameters<import("./ports.js").CaptureTransaction["update"]>[1],
      ) => {
        return this.repository.scoped(workspaceId, async (tx) => {
          const latest = await tx.load(requestId);
          if (!latest || latest.leaseToken !== token) return null;
          const guarded = { ...changes };
          if (terminal.has(latest.state)) delete guarded.state;
          else if (latest.state === "finalizing" && guarded.state !== "finalizing")
            delete guarded.state;
          else if (latest.stopRequested && guarded.state && guarded.state !== "finalizing")
            guarded.state = "stopping";
          if (guarded.providerId && latest.providerId && guarded.providerId !== latest.providerId)
            throw new AppError("PROVIDER_ID_CONFLICT", 409);
          guarded.stopRequested = latest.stopRequested || guarded.stopRequested === true;
          guarded.providerDone = latest.providerDone || guarded.providerDone === true;
          if (latest.departedAt) guarded.departedAt = latest.departedAt;
          const updated = await tx.update(requestId, guarded);
          await tx.emit(updated, "capture.state.changed.v1");
          return updated;
        });
      };
      if (claim.first) {
        const result = await this.provider.create({
          meetingUrl: current.joinUrl,
          attemptId: current.attemptId,
          transcriptWebhookUrl: this.webhookUrl,
          maxDurationSeconds: current.maxSeconds,
        });
        // Callback/stop may win this race. Only mutate a still-dispatching request.
        current = await this.repository.scoped(workspaceId, async (tx) => {
          const latest = await tx.load(requestId);
          if (!latest || latest.leaseToken !== token) throw new AppError("LEASE_LOST", 409);
          if (result.kind === "accepted") {
            if (latest.providerId && latest.providerId !== result.providerId)
              throw new AppError("PROVIDER_ID_CONFLICT", 409);
            const updated = await tx.update(requestId, {
              providerId: result.providerId,
              state: latest.state === "dispatching" ? "joining" : latest.state,
            });
            await tx.emit(updated, "capture.state.changed.v1");
            return updated;
          }
          if (latest.state !== "dispatching") return latest;
          const updated = await tx.update(requestId, {
            state:
              result.kind === "rejected" || result.kind === "capacity"
                ? "failed"
                : "dispatch_unknown",
            providerDone: result.kind === "rejected" || result.kind === "capacity",
            errorCode:
              result.kind === "capacity"
                ? "PROVIDER_CAPACITY"
                : result.kind === "rejected"
                  ? result.code === "AUTHENTICATION"
                    ? "PROVIDER_AUTHENTICATION"
                    : "INVALID_LINK"
                  : "DISPATCH_UNKNOWN",
          });
          await tx.emit(updated, "capture.state.changed.v1");
          return updated;
        });
      }
      if (
        !current.providerId &&
        ["dispatching", "dispatch_unknown", "stopping"].includes(current.state)
      ) {
        const found = await this.provider.findAttempt(current.attemptId);
        if (found.kind === "found")
          current =
            (await save({
              providerId: found.bot.providerId,
              state: current.stopRequested
                ? "stopping"
                : ["call_ended", "done", "fatal"].includes(found.bot.status)
                  ? "finalizing"
                  : "joining",
              ...(["call_ended", "done", "fatal"].includes(found.bot.status)
                ? {
                    departedAt: found.bot.occurredAt ? new Date(found.bot.occurredAt) : this.now(),
                    providerDone: ["done", "fatal"].includes(found.bot.status),
                  }
                : {}),
            })) ?? current;
        // No result is NOT proof that creation never happened. Never create another bot here.
      }
      if (current.providerId && !terminal.has(current.state)) {
        const snapshot = await this.provider.inspect(current.providerId);
        if (snapshot && ["call_ended", "done", "fatal"].includes(snapshot.status))
          current =
            (await save({
              state: "finalizing",
              departedAt:
                current.departedAt ??
                (snapshot.occurredAt ? new Date(snapshot.occurredAt) : this.now()),
              providerDone: ["done", "fatal"].includes(snapshot.status) || current.providerDone,
              transcriptHealth: "ended",
            })) ?? current;
        else if (
          current.stopRequested ||
          (current.dispatchAt &&
            this.now().getTime() >= current.dispatchAt.getTime() + current.maxSeconds * 1000)
        ) {
          current = (await save({ state: "stopping", stopRequested: true })) ?? current;
          await this.provider.leave(current.providerId!);
        }
      }
      if (
        current.state === "finalizing" &&
        current.departedAt &&
        current.providerDone &&
        this.now().getTime() >=
          Math.max(current.departedAt.getTime(), current.lastTranscriptAt?.getTime() ?? 0) + 30_000
      ) {
        current = await this.repository.scoped(workspaceId, async (tx) => {
          const latest = await tx.load(requestId);
          if (
            !latest ||
            latest.leaseToken !== token ||
            !latest.departedAt ||
            !latest.providerDone ||
            this.now().getTime() <
              Math.max(latest.departedAt.getTime(), latest.lastTranscriptAt?.getTime() ?? 0) +
                30_000
          )
            return latest ?? current;
          const state = finalOutcome({
            stopConfirmed: true,
            drainComplete: true,
            coverage: latest.coverage,
            finalSegmentCount: await tx.segmentCount(requestId),
            silenceConfirmed: false,
          });
          const finalized = await tx.update(requestId, { state });
          await tx.emit(finalized, "transcript.finalized.v1");
          return finalized;
        });
      }
      if (terminal.has(current.state) && current.quotaState === "held") {
        if (
          !current.dispatchAt ||
          (current.state === "failed" && !current.providerId && current.providerDone)
        ) {
          await this.usage.release(actorFor(current), requestId);
          await save({ quotaState: "released" });
        } else if (current.departedAt) {
          await this.usage.settle(
            actorFor(current),
            requestId,
            Math.max(
              0,
              Math.ceil((current.departedAt.getTime() - current.dispatchAt.getTime()) / 1000),
            ),
          );
          await save({ quotaState: "settled" });
        }
      }
    } finally {
      await this.repository.scoped(workspaceId, async (tx) => {
        const latest = await tx.load(requestId);
        if (latest?.leaseToken === token)
          await tx.update(requestId, { leaseUntil: null, leaseToken: null });
      });
    }
  }
  private async recoverAdmission(record: Capture) {
    const actor = actorFor(record);
    let reservation = await this.usage.lookup(actor, record.id);
    let failure: string | null = null;
    if (!terminal.has(record.state)) {
      try {
        const context = await this.meetings.capture(actor, record.meetingId);
        if (context.version !== record.meetingVersion || context.joinUrl !== record.joinUrl)
          throw new AppError("VERSION_CONFLICT", 409);
        if (!reservation) {
          const state = await this.usage.reserve(actor, record.id, record.maxSeconds);
          reservation = { state, maxSeconds: record.maxSeconds };
        }
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          ![400, 401, 402, 403, 404, 409, 429].includes(error.status)
        )
          throw error;
        failure = error.code;
        // An earlier reserve may have succeeded even if its reply was lost.
        reservation = await this.usage.lookup(actor, record.id);
      }
    }
    await this.repository.scoped(record.workspaceId, async (tx) => {
      const latest = await tx.load(record.id);
      if (!latest || latest.quotaState !== "pending") return;
      if (reservation && reservation.maxSeconds !== latest.maxSeconds)
        throw new AppError("RESERVATION_CONFLICT", 409);
      const closed = terminal.has(latest.state);
      const held = reservation?.state === "held";
      const updated = await tx.update(record.id, {
        quotaState: reservation?.state ?? "released",
        ready: !closed && !failure && held,
        state: closed ? latest.state : failure || !held ? "failed" : latest.state,
        errorCode: failure ?? (!closed && !held ? "RESERVATION_CONFLICT" : latest.errorCode),
        providerDone: failure !== null || latest.providerDone,
      });
      await tx.emit(updated, updated.ready ? "capture.requested.v1" : "capture.state.changed.v1");
    });
  }
}
