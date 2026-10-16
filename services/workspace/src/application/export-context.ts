import { AppError, type Actor } from "@visualsprint/platform";
import { id } from "@visualsprint/contracts";
import {
  agendaFingerprint,
  normalAgendaActor,
  type AgendaAuthority,
  type AgendaStore,
} from "./agendas.js";
import type { CommitmentsService } from "./commitments.js";
type Reviewed = Awaited<ReturnType<CommitmentsService["list"]>>[number];
const exportRecord = (row: Reviewed) => ({
  id: row.id,
  meetingId: row.meetingId,
  kind: row.kind,
  title: row.title,
  text: row.text,
  ownerId: row.ownerId,
  dueDate: row.dueDate,
  state: row.state,
  version: row.version,
  sourceMeetingVersion: row.sourceMeetingVersion,
  citations: row.citations,
  sourcePartial: row.sourcePartial,
  humanReviewed: true as const,
  humanCorrected: row.humanCorrected,
  evidenceStatus: row.evidenceStatus,
  statusSource: "human_review" as const,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
const index = (rows: { id: string; kind: string; version: number }[]) =>
  agendaFingerprint(
    [...rows]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
      .map(({ id, kind, version }) => ({ id, kind, version })),
  );
export class WorkspaceExportContext {
  constructor(
    private readonly authority: AgendaAuthority,
    private readonly store: Pick<AgendaStore, "snapshot">,
    private readonly records: Pick<CommitmentsService, "list">,
  ) {}
  async read(actor: Actor, meetingId: string) {
    normalAgendaActor(actor);
    id.parse(meetingId);
    const before = await this.authority.meeting(actor, meetingId);
    const snapshot = await this.store.snapshot(actor, meetingId);
    if (before.version !== snapshot.meetingVersion)
      throw new AppError("EXPORT_CONTEXT_CHANGED", 409);
    const scope = { kind: "meeting" as const, id: meetingId };
    const [decisions, commitments] = await Promise.all([
      this.records.list(actor, "decision", scope, true),
      this.records.list(actor, "commitment", scope, true),
    ]);
    const rows = [...decisions, ...commitments];
    if (
      rows.some((row) => row.meetingId !== meetingId) ||
      decisions.some((row) => row.kind !== "decision") ||
      commitments.some((row) => row.kind !== "commitment") ||
      decisions.length > 100 ||
      commitments.length > 100 ||
      index(rows) !== index(snapshot.accepted)
    )
      throw new AppError("EXPORT_CONTEXT_CHANGED", 409);
    const current = await this.store.snapshot(actor, meetingId);
    const after = await this.authority.meeting(actor, meetingId);
    if (
      after.version !== snapshot.meetingVersion ||
      agendaFingerprint(current) !== agendaFingerprint(snapshot)
    )
      throw new AppError("EXPORT_CONTEXT_CHANGED", 409);
    const result = {
      schemaVersion: 1 as const,
      complete: true as const,
      meetingId,
      meetingVersion: after.version,
      decisions: decisions.map(exportRecord),
      commitments: commitments.map(exportRecord),
      agendas: snapshot.agendas,
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 2_000_000)
      throw new AppError("EXPORT_CONTEXT_TOO_LARGE", 409);
    return result;
  }
}
