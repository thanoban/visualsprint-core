import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import { fingerprint, selectEvidence, validateClaims, type Scope } from "../domain/evidence.js";
import {
  commitmentQuestions,
  type PreparationDraft,
  type ReviewedCommitment,
  type ReviewedRecord,
} from "../domain/preparation.js";
import { commandKey, modelClaims, scope } from "./schemas.js";
import type { Model, Sources } from "./ports.js";

export const preparationInput = z
  .object({ meetingId: id, historyScope: scope, confirmedScope: z.literal(true) })
  .strict();
export interface ReviewedContext {
  meeting(actor: Actor, meetingId: string): Promise<{ id: string; version: number }>;
  commitments(actor: Actor, historyScope: Scope): Promise<ReviewedCommitment[]>;
  records?(actor: Actor, historyScope: Scope): Promise<ReviewedRecord[]>;
}
export interface PreparationStore {
  save(actor: Actor, key: string, draft: PreparationDraft): Promise<{ id: string }>;
}
const commitments = z
  .array(
    z
      .object({
        id,
        meetingId: id,
        version: z.number().int().positive(),
        text: z.string().trim().min(1).max(12000),
        state: z.enum(["open", "done", "unknown"]),
        dueAt: z.string().datetime().nullable(),
        verifiedAt: z.string().datetime().nullable(),
      })
      .strict(),
  )
  .max(200);
export class PrepareNextMeeting {
  constructor(
    private readonly sources: Sources,
    private readonly context: ReviewedContext,
    private readonly model: Model,
    private readonly store: PreparationStore,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async execute(actor: Actor, key: string, body: unknown) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    commandKey.parse(key);
    const input = preparationInput.parse(body);
    await this.sources.requireActive(actor);
    const target = await this.context.meeting(actor, input.meetingId);
    if (target.id !== input.meetingId) throw new AppError("NOT_FOUND", 404);
    const history = await this.sources.read(actor, input.historyScope);
    const hash = fingerprint(history);
    const reviewed = commitments.parse(await this.context.commitments(actor, input.historyScope));
    const records = this.context.records
      ? await this.context.records(actor, input.historyScope)
      : undefined;
    if (
      records &&
      (records.length > 200 ||
        records.some(
          (row) => !history.versions.some((version) => version.meetingId === row.meetingId),
        ))
    )
      throw new AppError("REVIEWED_RECORD_SCOPE_MISMATCH", 409);
    const questions = commitmentQuestions(
      reviewed,
      new Set(history.versions.map((row) => row.meetingId)),
      this.now(),
    );
    const evidence = selectEvidence(
      history,
      "previous decisions commitments risks unresolved questions",
    );
    const generated = evidence.length
      ? modelClaims.parse(
          await this.model.generate({ purpose: "summary", question: null, evidence }),
        )
      : { claims: [], unsupported: true };
    validateClaims(generated.claims, evidence);
    if (generated.unsupported && generated.claims.length)
      throw new AppError("INVALID_MODEL_RESULT", 502);
    const findings = generated.claims.filter(
      (claim) =>
        claim.kind === "discussion" ||
        !records?.some(
          (record) =>
            record.kind === claim.kind &&
            record.meetingId === claim.citation.meetingId &&
            record.citations.some(
              (citation) =>
                citation.captureId === claim.citation.captureId &&
                citation.segmentId === claim.citation.segmentId,
            ),
        ),
    );
    await this.sources.requireActive(actor);
    const currentTarget = await this.context.meeting(actor, input.meetingId);
    const currentHistory = await this.sources.read(actor, input.historyScope);
    const currentReviewed = commitments.parse(
      await this.context.commitments(actor, input.historyScope),
    );
    const currentRecords = this.context.records
      ? await this.context.records(actor, input.historyScope)
      : undefined;
    if (
      currentTarget.id !== target.id ||
      currentTarget.version !== target.version ||
      fingerprint(currentHistory) !== hash ||
      JSON.stringify(currentReviewed) !== JSON.stringify(reviewed) ||
      JSON.stringify(currentRecords) !== JSON.stringify(records)
    )
      throw new AppError("SOURCE_CHANGED", 409);
    return this.store.save(actor, key, {
      meetingId: target.id,
      meetingVersion: target.version,
      historyScope: input.historyScope,
      sourceFingerprint: hash,
      sourceVersions: history.versions,
      // Human reviewed records win over generated classifications of the same
      // source. Their edits/statuses are retained verbatim in reviewedRecords.
      findings,
      questions,
      partial:
        history.versions.some((row) => row.coverage !== "complete") ||
        Boolean(records?.some((row) => row.sourcePartial || row.evidenceStatus !== "current")),
      reviewRequired: true,
      ...(records ? { reviewedRecords: records } : {}),
    });
  }
}
