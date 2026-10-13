import { z } from "zod";
import { createHash } from "node:crypto";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import { fingerprint, type Scope, type SourceVersion } from "../domain/evidence.js";
import type {
  PreparationDraft,
  ReviewedCommitment,
  ReviewedRecord,
} from "../domain/preparation.js";
import type { Model, Sources } from "./ports.js";
import { commandKey } from "./schemas.js";
import { PrepareNextMeeting, preparationInput, type ReviewedContext } from "./preparation.js";

export type PreparationInput = z.infer<typeof preparationInput>;
export type PreparationJob = {
  workspaceId: string;
  id: string;
  ownerId: string;
  sessionId: string;
  input: PreparationInput;
  sourceVersions: SourceVersion[];
  status: "queued" | "running" | "complete" | "failed" | "invalidated";
  attempts: number;
  result: PreparationDraft | null;
  commitmentsFingerprint: string | null;
  errorCode: string | null;
  leaseToken: string | null;
  leaseUntil: Date | null;
  createdAt: Date;
};
export interface PreparationContext extends ReviewedContext {
  forInput?(input: PreparationInput): PreparationContext;
  authorizeScope(
    actor: Actor,
    scope: Scope,
  ): Promise<{ meetings: { id: string; version: number }[] }>;
}
export interface PreparationJobs {
  create(
    actor: Actor,
    key: string,
    input: PreparationInput,
    sourceVersions: SourceVersion[],
  ): Promise<PreparationJob>;
  load(actor: Actor, jobId: string): Promise<PreparationJob | null>;
  claim(workspaceId: string, jobId: string): Promise<PreparationJob | null>;
  pin(job: PreparationJob, sourceVersions: SourceVersion[]): Promise<boolean>;
  complete(
    job: PreparationJob,
    draft: PreparationDraft,
    commitmentsFingerprint: string,
  ): Promise<boolean>;
  fail(job: PreparationJob, code: string, transient: boolean): Promise<void>;
  invalidate(actor: Actor, jobId: string): Promise<void>;
  purgeMeeting(workspaceId: string, meetingId: string): Promise<void>;
  due(): Promise<{ workspaceId: string; id: string }[]>;
}
// Admission is owned by Account, not by a model or this service. Conservative
// input-byte bounds are token upper bounds, not claims of measured usage.
export interface ModelUsageAdmission {
  reserve(
    actor: Actor,
    input: {
      operationId: string;
      purpose: "preparation" | "summary" | "chat" | "indexing" | "retrieval";
      maxInputTokens: number;
      maxOutputTokens: number;
    },
  ): Promise<{
    reservationId: string;
    replay: boolean;
    state: "held" | "succeeded" | "unknown" | "not_started";
  }>;
  record(
    actor: Actor,
    reservationId: string,
    outcome: "succeeded" | "unknown" | "not_started",
  ): Promise<void>;
}
export class UnconfiguredModelUsageAdmission implements ModelUsageAdmission {
  async reserve(): Promise<never> {
    throw new AppError("MODEL_ADMISSION_NOT_CONFIGURED", 503);
  }
  async record(): Promise<never> {
    throw new AppError("MODEL_ADMISSION_NOT_CONFIGURED", 503);
  }
}
const frame = z
  .object({
    meetings: z.array(z.object({ id, version: z.number().int().positive() }).strict()).max(100),
  })
  .strict();
function commitmentFingerprint(items: ReviewedCommitment[], records?: ReviewedRecord[]) {
  return JSON.stringify({
    commitments: [...items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => ({
        id: item.id,
        meetingId: item.meetingId,
        version: item.version,
        text: item.text,
        state: item.state,
        dueAt: item.dueAt,
        verifiedAt: item.verifiedAt,
      })),
    records: records ? [...records].sort((a, b) => a.id.localeCompare(b.id)) : null,
  });
}
export function preparationAttemptId(jobId: string, attempt: number) {
  id.parse(jobId);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3)
    throw new Error("INVALID_PREPARATION_ATTEMPT");
  const namespace = Buffer.from("f570a846ff7448e285a5c8e58e1c79ca", "hex");
  const bytes = createHash("sha1")
    .update(namespace)
    .update(`${jobId}:${attempt}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class DurablePreparation {
  constructor(
    private readonly jobs: PreparationJobs,
    private readonly sources: Sources,
    private readonly context: PreparationContext,
    private readonly model: Model,
    private readonly admission: ModelUsageAdmission,
  ) {}
  private async user(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    await this.sources.requireActive(actor);
  }
  private historySources(targetId: string): Sources {
    return {
      requireActive: (actor) => this.sources.requireActive(actor),
      read: async (actor, scope) => {
        const snapshot = await this.sources.read(actor, scope);
        return {
          versions: snapshot.versions.filter((row) => row.meetingId !== targetId),
          evidence: snapshot.evidence.filter((row) => row.meetingId !== targetId),
        };
      },
    };
  }
  async request(actor: Actor, key: string, body: unknown) {
    await this.user(actor);
    commandKey.parse(key);
    const input = preparationInput.parse(body);
    const context = this.context.forInput?.(input) ?? this.context;
    const target = await context.meeting(actor, input.meetingId);
    if (target.id !== input.meetingId) throw new AppError("NOT_FOUND", 404);
    const allowed = frame.parse(await context.authorizeScope(actor, input.historyScope));
    if (new Set(allowed.meetings.map((row) => row.id)).size !== allowed.meetings.length)
      throw new AppError("INVALID_SCOPE_CONTEXT", 503);
    const versions: SourceVersion[] = allowed.meetings.map((row) => ({
      meetingId: row.id,
      version: row.version,
      captureId: null,
      captureVersion: null,
      coverage: "unknown",
    }));
    return preparationJobView(await this.jobs.create(actor, key, input, versions));
  }
  async status(actor: Actor, jobId: string) {
    await this.user(actor);
    const job = await this.jobs.load(actor, id.parse(jobId));
    if (!job) throw new AppError("NOT_FOUND", 404);
    const context = this.context.forInput?.(job.input) ?? this.context;
    const sources = this.historySources(job.input.meetingId);
    const target = await context.meeting(actor, job.input.meetingId);
    if (target.id !== job.input.meetingId) throw new AppError("NOT_FOUND", 404);
    await context.authorizeScope(actor, job.input.historyScope);
    if (job.result) {
      const current = await sources.read(actor, job.input.historyScope);
      const reviewed = await context.commitments(actor, job.input.historyScope);
      const records = context.records
        ? await context.records(actor, job.input.historyScope)
        : undefined;
      if (
        target.version !== job.result.meetingVersion ||
        fingerprint(current) !== job.result.sourceFingerprint ||
        commitmentFingerprint(reviewed, records) !== job.commitmentsFingerprint
      ) {
        await this.jobs.invalidate(actor, job.id);
        return preparationJobView({
          ...job,
          status: "invalidated",
          result: null,
          errorCode: "SOURCE_CHANGED",
        });
      }
    }
    return preparationJobView(job);
  }
  async work(workspaceId: string, jobId: string) {
    const job = await this.jobs.claim(workspaceId, jobId);
    if (!job) return;
    const actor: Actor = { workspaceId, actorId: job.ownerId, sessionId: job.sessionId };
    const boundContext = this.context.forInput?.(job.input) ?? this.context;
    const historySources = this.historySources(job.input.meetingId);
    let pinned = false,
      pinnedHash = "",
      reviewedHash = "";
    try {
      await this.user(actor);
      await boundContext.authorizeScope(actor, job.input.historyScope);
      const sources: Sources = {
        requireActive: (actor) => this.sources.requireActive(actor),
        read: async (actor, scope) => {
          const snapshot = await historySources.read(actor, scope);
          if (!pinned) {
            if (!(await this.jobs.pin(job, snapshot.versions)))
              throw new AppError("LEASE_LOST", 409);
            pinned = true;
            pinnedHash = fingerprint(snapshot);
          }
          return snapshot;
        },
      };
      const context: ReviewedContext = {
        meeting: (actor, id) => boundContext.meeting(actor, id),
        commitments: async (actor, scope) => {
          const items = await boundContext.commitments(actor, scope);
          reviewedHash = commitmentFingerprint(items);
          return items;
        },
        ...(boundContext.records
          ? {
              records: async (actor: Actor, scope: Scope) => {
                const records = await boundContext.records!(actor, scope);
                const commitments = await boundContext.commitments(actor, scope);
                reviewedHash = commitmentFingerprint(commitments, records);
                return records;
              },
            }
          : {}),
      };
      const meteredModel: Model = {
        generate: async (input) => {
          const maximum = Buffer.byteLength(JSON.stringify(input), "utf8") + 4096;
          if (maximum > 250_000) throw new AppError("MODEL_INPUT_TOO_LARGE", 409);
          // Recovery of a lost provider response is not a fresh paid operation.
          const operationId = preparationAttemptId(job.id, 1);
          const reservation = await this.admission.reserve(actor, {
            operationId,
            purpose: "preparation",
            maxInputTokens: maximum,
            maxOutputTokens: 6000,
          });
          id.parse(reservation.reservationId);
          if (reservation.replay || reservation.state !== "held")
            throw new AppError("MODEL_RESERVATION_REPLAY", 409);
          try {
            await this.user(actor);
            await boundContext.authorizeScope(actor, job.input.historyScope);
            if (
              fingerprint(await historySources.read(actor, job.input.historyScope)) !== pinnedHash
            )
              throw new AppError("SOURCE_CHANGED", 409);
          } catch (error) {
            await this.admission.record(actor, reservation.reservationId, "not_started");
            throw error;
          }
          let output: unknown;
          try {
            output = await this.model.generate(input);
          } catch (error) {
            await this.admission.record(actor, reservation.reservationId, "unknown");
            throw new AppError("MODEL_DISPATCH_UNKNOWN", 409);
          }
          await this.admission.record(actor, reservation.reservationId, "succeeded");
          return output;
        },
      };
      const generator = new PrepareNextMeeting(sources, context, meteredModel, {
        save: async (_actor, _key, draft) => {
          if (!(await this.jobs.complete(job, draft, reviewedHash)))
            throw new AppError("LEASE_LOST", 409);
          return { id: job.id };
        },
      });
      await generator.execute(actor, `preparation:${job.id}`, job.input);
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof Error &&
              ["COMMITMENT_SCOPE_MISMATCH", "COMMITMENTS_TOO_LARGE", "UNSUPPORTED_CLAIM"].includes(
                error.message,
              )
            ? error.message
            : "PREPARATION_UNAVAILABLE";
      await this.jobs.fail(job, code, error instanceof AppError && error.status >= 500);
    }
  }
}
export function preparationJobView(job: PreparationJob) {
  return {
    id: job.id,
    status: job.status,
    result: job.result,
    errorCode: job.errorCode,
    attempts: job.attempts,
    createdAt: job.createdAt,
  };
}
