import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import { z } from "zod";
import { evidenceFingerprint, render } from "../domain/export.js";
import { deletionInput, exportInput } from "./contracts.js";
import type { EvidenceSource, ExportJob, ExportRepository } from "./ports.js";
const keySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const view = (job: ExportJob) => ({
  id: job.id,
  meetingId: job.meetingId,
  format: job.format,
  state: job.state,
  version: job.version,
  errorCode: job.errorCode,
  expiresAt: job.expiresAt.toISOString(),
});
export class ReportingService {
  constructor(
    private readonly repository: ExportRepository,
    private readonly source: EvidenceSource,
    private readonly now = () => new Date(),
  ) {}
  private user(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
  }
  async create(actor: Actor, key: string, body: unknown) {
    this.user(actor);
    const input = exportInput.parse(body);
    await this.source.authorize(actor, input.meetingId);
    return view(await this.repository.create(actor, keySchema.parse(key), input, this.now()));
  }
  private async owned(actor: Actor, exportId: string) {
    this.user(actor);
    const job = await this.repository.get(actor.workspaceId, id.parse(exportId));
    if (!job || job.ownerId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
    await this.source.authorize(actor, job.meetingId);
    return job;
  }
  async status(actor: Actor, exportId: string) {
    const job = await this.owned(actor, exportId);
    if (job.expiresAt <= this.now())
      return { ...view(job), state: job.state === "deleted" ? "deleted" : "expired" };
    return view(job);
  }
  async download(actor: Actor, exportId: string) {
    const job = await this.owned(actor, exportId);
    if (job.state !== "complete" || !job.content || job.expiresAt <= this.now())
      throw new AppError("EXPORT_NOT_AVAILABLE", 409);
    const current = await this.source.load(actor, job.meetingId);
    if (evidenceFingerprint(current) !== job.fingerprint)
      throw new AppError("EXPORT_SOURCE_CHANGED", 409);
    await this.source.authorize(actor, job.meetingId);
    const fence = await this.repository.get(actor.workspaceId, exportId);
    if (fence?.state !== "complete" || fence.version !== job.version)
      throw new AppError("EXPORT_NOT_AVAILABLE", 409);
    return { content: job.content, format: job.format, id: job.id };
  }
  async work(workspaceId: string, exportId: string) {
    const job = await this.repository.claim(id.parse(workspaceId), id.parse(exportId), this.now());
    if (!job) return;
    const actor = { workspaceId: job.workspaceId, actorId: job.ownerId, sessionId: job.sessionId };
    try {
      const evidence = await this.source.load(actor, job.meetingId);
      const fingerprint = evidenceFingerprint(evidence);
      const content = render(evidence, job.format);
      const current = await this.source.load(actor, job.meetingId);
      if (evidenceFingerprint(current) !== fingerprint)
        throw new AppError("EXPORT_SOURCE_CHANGED", 503);
      await this.source.authorize(actor, job.meetingId);
      await this.repository.finish(job, { state: "complete", content, fingerprint }, this.now());
    } catch (error) {
      const denied = error instanceof AppError && [401, 403, 404, 410].includes(error.status);
      const waiting = error instanceof AppError && error.code === "EXPORT_CAPTURE_NOT_FINAL";
      const tooLarge = error instanceof Error && error.message === "EXPORT_SIZE_LIMIT";
      await this.repository.finish(
        job,
        {
          state: denied
            ? "blocked"
            : waiting
              ? "queued"
              : tooLarge || job.attempts >= 5
                ? "failed"
                : "queued",
          errorCode: denied
            ? "EXPORT_ACCESS_REVOKED"
            : waiting
              ? "EXPORT_CAPTURE_NOT_FINAL"
              : tooLarge
                ? "EXPORT_SIZE_LIMIT"
                : "EXPORT_SOURCE_UNAVAILABLE",
        },
        this.now(),
      );
    }
  }
  async delete(workspaceId: string, deletionId: string, body: unknown) {
    const input = deletionInput.parse(body);
    await this.repository.remove(id.parse(workspaceId), id.parse(deletionId), input);
    return { deletionId, meetingId: input.meetingId, participant: "reporting", state: "complete" };
  }
}
