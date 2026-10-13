import { createHash } from "node:crypto";
import { AppError, type Actor } from "@visualsprint/platform";
import type { CalendarMeeting } from "@visualsprint/contracts";
import type { CalendarMeetings, CalendarAuthority } from "./ports.js";
import type { Connection } from "../domain/records.js";

export type CaptureIntent = {
  meetingId: string;
  expectedMeetingVersion: number;
  startsAt: string;
  maxDurationSeconds: number;
};
export type CalendarCaptureView = { id: string; state: string; stopRequested: boolean };
export interface CalendarCaptures {
  request(actor: Actor, key: string, input: CaptureIntent): Promise<CalendarCaptureView>;
  command(actor: Actor, key: string, cancel: boolean): Promise<CalendarCaptureView | null>;
}
export type CalendarCaptureTask = {
  workspaceId: string;
  connectionId: string;
  occurrenceId: string;
  ownerId: string;
  grantId: string;
  target: CalendarMeeting;
  enabled: boolean;
  attempt: number;
  key: string | null;
  intent: CaptureIntent | null;
  intentFingerprint: string | null;
  captureId: string | null;
  leaseToken: string;
};
export interface CalendarCaptureTasks {
  current(task: CalendarCaptureTask): Promise<boolean>;
  refresh(connection: Connection): Promise<void>;
  claim(workspaceId: string, connectionId: string): Promise<CalendarCaptureTask | null>;
  save(
    task: CalendarCaptureTask,
    changes: Partial<
      Pick<CalendarCaptureTask, "attempt" | "key" | "intent" | "intentFingerprint" | "captureId">
    >,
  ): Promise<void>;
  release(task: CalendarCaptureTask): Promise<void>;
}
const finished = new Set(["complete", "partial", "failed", "cancelled"]);
export class CalendarCaptureOrchestrator {
  constructor(
    private readonly tasks: CalendarCaptureTasks,
    private readonly authority: CalendarAuthority,
    private readonly meetings: CalendarMeetings,
    private readonly captures: CalendarCaptures,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async work(connection: Connection) {
    await this.tasks.refresh(connection);
    for (let i = 0; i < 10; i++) {
      const task = await this.tasks.claim(connection.workspaceId, connection.id);
      if (!task) return;
      try {
        await this.run(task, connection);
      } finally {
        await this.tasks.release(task);
      }
    }
  }
  private async run(task: CalendarCaptureTask, connection: Connection) {
    const actor: Actor = {
      actorId: task.ownerId,
      workspaceId: task.workspaceId,
      operationGrantId: task.grantId,
      sessionId: `operation:${task.grantId}`,
    };
    let authorized =
      task.enabled &&
      connection.automatic &&
      task.grantId === connection.grantId &&
      connection.status === "connected";
    if (authorized) {
      try {
        authorized = (await this.authority.operation(actor)).connectionId === task.connectionId;
      } catch (error) {
        if (!(error instanceof AppError) || ![401, 403, 404].includes(error.status)) throw error;
        authorized = false;
      }
    }
    const target = task.target;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          target.joinUrl,
          target.startsAt,
          target.status,
          target.allDay,
          target.declined,
        ]),
      )
      .digest("hex");
    const eligible =
      authorized &&
      target.status === "confirmed" &&
      !target.allDay &&
      !target.declined &&
      Boolean(target.joinUrl && target.startsAt && target.endsAt);
    if (task.key && (!eligible || fingerprint !== task.intentFingerprint)) {
      // Cancellation fences even an uncertain/lost create response before a replacement key.
      const previous = await this.captures.command(actor, task.key, true);
      if (previous && !finished.has(previous.state)) return;
      await this.tasks.save(task, {
        key: null,
        intent: null,
        intentFingerprint: null,
        captureId: null,
        attempt: task.attempt + 1,
      });
      task = {
        ...task,
        key: null,
        intent: null,
        intentFingerprint: null,
        captureId: null,
        attempt: task.attempt + 1,
      };
    }
    if (!eligible) {
      // Publish explicit cancellation/decline into an existing private meeting, without creating a new ineligible one.
      if (authorized) {
        try {
          await this.meetings.upsert(actor, target);
        } catch (error) {
          if (!(error instanceof AppError) || ![400, 404, 409].includes(error.status)) throw error;
        }
      }
      return;
    }
    const meeting = await this.meetings.upsert(actor, target);
    if (task.key) {
      const previous = await this.captures.command(actor, task.key, false);
      if (previous) {
        await this.tasks.save(task, { captureId: previous.id });
        return;
      }
    } else {
      // Missed windows are not joined late without a deliberate ad-hoc user command.
      if (
        Date.parse(target.startsAt!) < this.now().getTime() - 300000 ||
        Date.parse(target.endsAt!) <= this.now().getTime()
      )
        return;
      task = {
        ...task,
        key: `calendar:${task.grantId}:${task.occurrenceId}:${task.attempt}`,
        intent: {
          meetingId: meeting.id,
          expectedMeetingVersion: meeting.version,
          startsAt: target.startsAt!,
          maxDurationSeconds: 14400,
        },
        intentFingerprint: fingerprint,
      };
      await this.tasks.save(task, {
        key: task.key,
        intent: task.intent,
        intentFingerprint: fingerprint,
      });
    }
    try {
      if (!(await this.tasks.current(task))) return;
      const result = await this.captures.request(actor, task.key!, task.intent!);
      await this.tasks.save(task, { captureId: result.id });
    } catch (error) {
      if (!(error instanceof AppError) || ![400, 401, 403, 404, 409].includes(error.status))
        throw error;
      // A deterministic rejection may follow intent persistence. Fence the key, not just the HTTP call.
      const previous = await this.captures.command(actor, task.key!, true);
      if (previous && !finished.has(previous.state)) return;
      await this.tasks.save(task, {
        key: null,
        intent: null,
        intentFingerprint: null,
        captureId: null,
        attempt: task.attempt + 1,
      });
    }
  }
}
