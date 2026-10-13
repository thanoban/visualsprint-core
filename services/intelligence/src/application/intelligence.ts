import { randomUUID } from "node:crypto";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import {
  fingerprint,
  selectEvidence,
  validateClaims,
  type Result,
  type Scope,
} from "../domain/evidence.js";
import type { Job, Model, Repository, Sources, Thread } from "./ports.js";
import { commandKey, messageInput, modelClaims, summaryInput, threadInput } from "./schemas.js";

export class IntelligenceService {
  constructor(
    private readonly repository: Repository,
    private readonly sources: Sources,
    private readonly model: Model,
  ) {}
  private async user(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    await this.sources.requireActive(actor);
  }
  async createThread(actor: Actor, key: string, body: unknown) {
    await this.user(actor);
    commandKey.parse(key);
    const input = threadInput.parse(body);
    await this.sources.read(actor, input.scope);
    return this.repository.scoped(actor.workspaceId, (tx) =>
      tx.command(actor.actorId, key, { kind: "thread", ...input }, async () =>
        tx.insertThread({
          workspaceId: actor.workspaceId,
          id: randomUUID(),
          ownerId: actor.actorId,
          title: input.title,
          scope: input.scope,
          version: 1,
          createdAt: new Date(),
        }),
      ),
    );
  }
  async threads(actor: Actor) {
    await this.user(actor);
    return this.repository.scoped(actor.workspaceId, (tx) => tx.threads(actor.actorId));
  }
  private async requireThread(actor: Actor, threadId: string): Promise<Thread> {
    const thread = await this.repository.scoped(actor.workspaceId, (tx) =>
      tx.thread(id.parse(threadId), actor.actorId),
    );
    if (!thread) throw new AppError("NOT_FOUND", 404);
    return thread;
  }
  private enqueue(
    actor: Actor,
    key: string,
    input: { kind: Job["kind"]; scope: Scope; threadId: string | null; question: string | null },
  ) {
    return this.repository.scoped(actor.workspaceId, (tx) =>
      tx.command(actor.actorId, key, input, async () =>
        tx.insertJob({
          workspaceId: actor.workspaceId,
          id: randomUUID(),
          ownerId: actor.actorId,
          sessionId: actor.sessionId,
          ...input,
          status: "queued",
          attempts: 0,
          result: null,
          sourceVersions: null,
          errorCode: null,
          leaseToken: null,
          leaseUntil: null,
          createdAt: new Date(),
        }),
      ),
    );
  }
  async summary(actor: Actor, key: string, body: unknown) {
    await this.user(actor);
    commandKey.parse(key);
    const input = summaryInput.parse(body);
    const scope: Scope = { kind: "meeting", id: input.meetingId };
    await this.sources.read(actor, scope);
    return jobView(
      await this.enqueue(actor, key, { kind: "summary", scope, threadId: null, question: null }),
    );
  }
  async message(actor: Actor, threadId: string, key: string, body: unknown) {
    await this.user(actor);
    commandKey.parse(key);
    const input = messageInput.parse(body);
    const thread = await this.requireThread(actor, threadId);
    await this.sources.read(actor, thread.scope);
    return jobView(
      await this.enqueue(actor, key, {
        kind: "answer",
        scope: thread.scope,
        threadId: thread.id,
        question: input.text,
      }),
    );
  }
  async job(actor: Actor, jobId: string) {
    await this.user(actor);
    const job = await this.repository.scoped(actor.workspaceId, (tx) =>
      tx.job(id.parse(jobId), actor.actorId),
    );
    if (!job) throw new AppError("NOT_FOUND", 404);
    // Even previously published/cached text is inaccessible after source revocation.
    const snapshot = await this.sources.read(actor, job.scope);
    if (job.result && fingerprint(snapshot) !== job.result.sourceFingerprint) {
      await this.repository.scoped(actor.workspaceId, (tx) => tx.invalidate(job.id));
      return jobView({ ...job, status: "invalidated", result: null, errorCode: "SOURCE_CHANGED" });
    }
    return jobView(job);
  }
  async messages(actor: Actor, threadId: string) {
    await this.user(actor);
    const thread = await this.requireThread(actor, threadId);
    const jobs = await this.repository.scoped(actor.workspaceId, (tx) =>
      tx.messages(thread.id, actor.actorId),
    );
    const snapshot = await this.sources.read(actor, thread.scope);
    const hash = fingerprint(snapshot);
    const views = [];
    for (const job of jobs) {
      if (job.result && job.result.sourceFingerprint !== hash) {
        await this.repository.scoped(actor.workspaceId, (tx) => tx.invalidate(job.id));
        views.push(
          jobView({ ...job, status: "invalidated", result: null, errorCode: "SOURCE_CHANGED" }),
        );
      } else views.push(jobView(job));
    }
    return { thread, messages: views };
  }
  async summaries(actor: Actor, meetingId: string) {
    await this.user(actor);
    id.parse(meetingId);
    const jobs = await this.repository.scoped(actor.workspaceId, (tx) =>
      tx.summaries(meetingId, actor.actorId),
    );
    const snapshot = await this.sources.read(actor, { kind: "meeting", id: meetingId });
    const hash = fingerprint(snapshot);
    const views = [];
    for (const job of jobs) {
      if (job.result && job.result.sourceFingerprint !== hash) {
        await this.repository.scoped(actor.workspaceId, (tx) => tx.invalidate(job.id));
        views.push(
          jobView({ ...job, status: "invalidated", result: null, errorCode: "SOURCE_CHANGED" }),
        );
      } else views.push(jobView(job));
    }
    return views;
  }
  async work(workspaceId: string, jobId: string) {
    const job = await this.repository.scoped(workspaceId, (tx) => tx.claim(jobId));
    if (!job) return;
    const actor: Actor = { workspaceId, actorId: job.ownerId, sessionId: job.sessionId };
    try {
      await this.user(actor);
      const snapshot = await this.sources.read(actor, job.scope);
      const hash = fingerprint(snapshot);
      const evidence = selectEvidence(snapshot, job.question);
      if (
        !(await this.repository.scoped(workspaceId, (tx) =>
          tx.pinSources(job.id, job.leaseToken!, snapshot.versions),
        ))
      )
        return;
      const generated = evidence.length
        ? modelClaims.parse(
            await this.model.generate({ purpose: job.kind, question: job.question, evidence }),
          )
        : { claims: [], unsupported: true };
      validateClaims(generated.claims, evidence);
      if (generated.unsupported && generated.claims.length) throw new Error("INVALID_MODEL_RESULT");
      await this.user(actor);
      const current = await this.sources.read(actor, job.scope);
      if (fingerprint(current) !== hash) throw new AppError("SOURCE_CHANGED", 409);
      const result: Result = {
        ...generated,
        partial: snapshot.versions.some((v) => v.coverage !== "complete"),
        sourceFingerprint: hash,
        sourceVersions: snapshot.versions,
        reviewRequired: true,
      };
      await this.repository.scoped(workspaceId, (tx) =>
        tx.complete(job.id, job.leaseToken!, result, evidence),
      );
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof Error &&
              ["UNSUPPORTED_CLAIM", "EVIDENCE_TOO_LARGE", "INVALID_MODEL_RESULT"].includes(
                error.message,
              )
            ? error.message
            : "MODEL_OR_SOURCE_UNAVAILABLE";
      const retry = error instanceof AppError && error.status >= 500 && job.attempts < 3;
      await this.repository.scoped(workspaceId, (tx) =>
        tx.fail(job.id, job.leaseToken!, code, retry),
      );
    }
  }
  // Cleanup capability exposes no content. The HTTP adapter requires a signed
  // Workspace caller; its deletion ID is persisted for restore/replay safety.
  purgeMeeting(workspaceId: string, meetingId: string, deletionId: string, sourceVersion: number) {
    return this.repository.scoped(id.parse(workspaceId), (tx) =>
      tx.purgeMeeting(id.parse(meetingId), id.parse(deletionId), sourceVersion),
    );
  }
}
export function jobView(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    threadId: job.threadId,
    question: job.question,
    status: job.status,
    result: job.result,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
  };
}
