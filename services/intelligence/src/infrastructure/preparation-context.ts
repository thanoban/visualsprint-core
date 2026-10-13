import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { PreparationContext, PreparationInput } from "../application/preparation-jobs.js";
import type { ReviewedRecord } from "../domain/preparation.js";
import type { Scope } from "../domain/evidence.js";
import { scope as scopeSchema } from "../application/schemas.js";
import { IntelligenceInternalClient } from "./internal-client.js";

const meeting = z
  .object({ id, version: z.number().int().positive(), title: z.string().max(200) })
  .strict();
const fact = z
  .object({
    id,
    meetingId: id,
    version: z.number().int().positive(),
    title: z.string().min(1).max(250),
    text: z.string().min(1).max(12000),
    state: z.enum(["accepted", "superseded", "open", "completed", "cancelled"]),
    ownerId: id.nullable(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    statusSource: z.literal("human_review"),
    updatedAt: z.string().datetime(),
    citations: z
      .array(
        z
          .object({ captureId: id, segmentId: id, revision: z.number().int().nonnegative() })
          .strict(),
      )
      .max(100),
    evidenceStatus: z.enum(["current", "changed", "unavailable"]),
    sourcePartial: z.boolean(),
    externalStatus: z.literal("unknown"),
    externalVerifiedAt: z.null(),
  })
  .strict();
export const preparationContextResponse = z
  .object({
    target: meeting,
    history: z.object({ scope: scopeSchema, meetings: z.array(meeting).max(100) }).strict(),
    decisions: z.array(fact).max(100),
    commitments: z.array(fact).max(100),
  })
  .strict();

// Bound per durable command, not cached by actor/session: two concurrent jobs
// cannot accidentally borrow each other's target or history scope.
export class AuthorizedPreparationContext implements PreparationContext {
  constructor(
    private readonly client: IntelligenceInternalClient,
    private readonly input?: PreparationInput,
  ) {}
  forInput(input: PreparationInput) {
    return new AuthorizedPreparationContext(this.client, input);
  }
  private async read(actor: Actor, scope?: Scope) {
    if (!this.input) throw new AppError("PREPARATION_CONTEXT_NOT_BOUND", 503);
    if (
      scope &&
      (scope.kind !== this.input.historyScope.kind || scope.id !== this.input.historyScope.id)
    )
      throw new AppError("PREPARATION_CONTEXT_MISMATCH", 409);
    let result: z.infer<typeof preparationContextResponse>;
    try {
      result = preparationContextResponse.parse(
        await this.client.post(
          actor,
          `/internal/workspaces/${id.parse(actor.workspaceId)}/preparation-context`,
          this.input,
        ),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("INVALID_PREPARATION_CONTEXT", 503);
    }
    const allowed = new Set(result.history.meetings.map((row) => row.id));
    if (
      result.target.id !== this.input.meetingId ||
      allowed.has(this.input.meetingId) ||
      allowed.size !== result.history.meetings.length ||
      result.history.scope.kind !== this.input.historyScope.kind ||
      result.history.scope.id !== this.input.historyScope.id ||
      [...result.decisions, ...result.commitments].some((row) => !allowed.has(row.meetingId)) ||
      result.decisions.some((row) => !["accepted", "superseded"].includes(row.state)) ||
      result.commitments.some((row) => !["open", "completed", "cancelled"].includes(row.state))
    )
      throw new AppError("INVALID_PREPARATION_CONTEXT", 503);
    return result;
  }
  async meeting(actor: Actor, meetingId: string) {
    const result = await this.read(actor);
    if (result.target.id !== meetingId) throw new AppError("NOT_FOUND", 404);
    return result.target;
  }
  async authorizeScope(actor: Actor, scope: Scope) {
    const result = await this.read(actor, scope);
    return { meetings: result.history.meetings.map(({ id, version }) => ({ id, version })) };
  }
  async commitments(actor: Actor, scope: Scope) {
    return (await this.read(actor, scope)).commitments.map((row) => ({
      id: row.id,
      meetingId: row.meetingId,
      version: row.version,
      text: row.text,
      state: row.state === "open" ? ("open" as const) : ("done" as const),
      dueAt: row.dueDate ? `${row.dueDate}T00:00:00.000Z` : null,
      // A manual mark is not an independently verified external completion.
      verifiedAt: null,
    }));
  }
  async records(actor: Actor, scope: Scope): Promise<ReviewedRecord[]> {
    const result = await this.read(actor, scope);
    return [
      ...result.decisions.map((row) => ({ ...row, kind: "decision" as const })),
      ...result.commitments.map((row) => ({ ...row, kind: "commitment" as const })),
    ].sort((a, b) => a.id.localeCompare(b.id));
  }
}
