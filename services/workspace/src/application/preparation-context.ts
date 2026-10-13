import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { WorkspaceService } from "./workspace.js";
import type { CommitmentsService } from "./commitments.js";

export const preparationContextInput = z
  .object({
    meetingId: id,
    historyScope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("workspace"), id: z.null() }).strict(),
      z.object({ kind: z.enum(["meeting", "project", "customer"]), id }).strict(),
    ]),
    confirmedScope: z.literal(true),
  })
  .strict();

type WorkspaceContext = Pick<WorkspaceService, "meeting" | "manageContext" | "intelligenceContext">;
type ReviewedRecords = Pick<CommitmentsService, "list">;
const frame = (rows: { id: string; version: number }[]) =>
  JSON.stringify(
    [...rows].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, version }) => ({ id, version })),
  );

// Read-only composition within the owning Workspace service. Intelligence never reads our tables.
export class WorkspacePreparationContext {
  constructor(
    private readonly workspace: WorkspaceContext,
    private readonly records: ReviewedRecords,
  ) {}
  async read(actor: Actor, body: unknown) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    const input = preparationContextInput.parse(body);
    if (input.historyScope.kind === "meeting" && input.historyScope.id === input.meetingId)
      throw new AppError("TARGET_IS_NOT_HISTORY", 400);
    await this.workspace.manageContext(actor, input.meetingId);
    const target = await this.workspace.meeting(actor, input.meetingId);
    const snapshot = await this.workspace.intelligenceContext(actor, { scope: input.historyScope });
    const meetings = snapshot.meetings.filter((meeting) => meeting.id !== input.meetingId);
    const allowed = new Set(meetings.map((meeting) => meeting.id));
    const [decisions, commitments] = await Promise.all([
      this.records.list(actor, "decision", input.historyScope, true),
      this.records.list(actor, "commitment", input.historyScope, true),
    ]);
    const current = await this.workspace.intelligenceContext(actor, { scope: input.historyScope });
    await this.workspace.manageContext(actor, input.meetingId);
    const currentTarget = await this.workspace.meeting(actor, input.meetingId);
    if (
      currentTarget.version !== target.version ||
      frame(current.meetings) !== frame(snapshot.meetings)
    )
      throw new AppError("PREPARATION_CONTEXT_CHANGED", 409);
    const reviewed = (rows: typeof commitments) =>
      rows
        .filter((item) => allowed.has(item.meetingId))
        .map((item) => ({
          id: item.id,
          meetingId: item.meetingId,
          version: item.version,
          title: item.title,
          text: item.text,
          state: item.state,
          ownerId: item.ownerId,
          dueDate: item.dueDate,
          statusSource: "human_review" as const,
          updatedAt: item.updatedAt,
          citations: item.citations.map(({ captureId, segmentId, revision }) => ({
            captureId,
            segmentId,
            revision,
          })),
          evidenceStatus: item.evidenceStatus,
          sourcePartial: item.sourcePartial,
          externalStatus: "unknown" as const,
          externalVerifiedAt: null,
        }));
    return {
      target: { id: target.id, version: target.version, title: target.title },
      history: {
        scope: input.historyScope,
        meetings: meetings.map(({ id, version, title }) => ({ id, version, title })),
      },
      decisions: reviewed(decisions),
      commitments: reviewed(commitments),
    };
  }
}
