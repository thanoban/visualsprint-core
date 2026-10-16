import type pg from "pg";
import { eventEnvelope, id } from "@visualsprint/contracts";
import { AppError } from "@visualsprint/platform";
import type {
  CapturePublication,
  CapturePublicationRepository,
} from "../application/capture-processing-publication.js";
export class PostgresCapturePublications implements CapturePublicationRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async scoped<T>(workspaceId: string, work: (db: pg.PoolClient) => Promise<T>) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.workspace_id',$1,true)", [id.parse(workspaceId)]);
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  async due() {
    return (
      await this.pool.query(
        "SELECT workspace_id,capture_id FROM capture_processing_publish_index WHERE next_at<=now() ORDER BY next_at,workspace_id,capture_id LIMIT 20",
      )
    ).rows.map((row) => ({
      workspaceId: id.parse(row.workspace_id),
      captureId: id.parse(row.capture_id),
    }));
  }
  private async current(
    db: pg.PoolClient,
    workspaceId: string,
    captureId: string,
    lock = false,
  ): Promise<CapturePublication | null> {
    const row = (
      await db.query(
        `SELECT c.id,c.meeting_id,c.owner_id,c.transcript_revision,i.consent_id,i.consent_version,i.policy_version FROM capture_requests c JOIN capture_processing_intents i ON i.workspace_id=c.workspace_id AND i.capture_id=c.id WHERE c.workspace_id=$1 AND c.id=$2 AND c.state IN ('complete','partial') AND c.transcript_revision>0 AND i.state='ready' AND i.consent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM meeting_deletions d WHERE d.workspace_id=c.workspace_id AND d.meeting_id=c.meeting_id) ${lock ? "FOR UPDATE OF c,i" : ""}`,
        [workspaceId, id.parse(captureId)],
      )
    ).rows[0];
    return row
      ? {
          workspaceId,
          captureId: String(row.id),
          meetingId: String(row.meeting_id),
          ownerId: String(row.owner_id),
          transcriptRevision: Number(row.transcript_revision),
          consentId: String(row.consent_id),
          consentVersion: Number(row.consent_version),
          policyVersion: "english-text-v1",
        }
      : null;
  }
  candidate(workspaceId: string, captureId: string) {
    return this.scoped(workspaceId, (db) => this.current(db, workspaceId, captureId));
  }
  commit(
    candidate: CapturePublication,
    decision: Parameters<CapturePublicationRepository["commit"]>[1],
  ) {
    return this.scoped(candidate.workspaceId, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${candidate.workspaceId}:meeting:${candidate.meetingId}`,
      ]);
      await db.query("SELECT 1 FROM capture_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [
        candidate.workspaceId,
        candidate.captureId,
      ]);
      const current = await this.current(db, candidate.workspaceId, candidate.captureId, true);
      if (!current || JSON.stringify(current) !== JSON.stringify(candidate))
        throw new AppError("PROCESSING_CONTEXT_CHANGED", 409);
      if ("event" in decision) {
        const event = eventEnvelope.parse(decision.event);
        if (
          event.type !== "capture.processing.ready.v1" ||
          event.workspaceId !== candidate.workspaceId ||
          event.aggregateId !== candidate.captureId ||
          event.aggregateVersion !== candidate.transcriptRevision ||
          event.actorId !== candidate.ownerId ||
          !event.references.some(
            (ref) => ref.kind === "meeting" && ref.id === candidate.meetingId,
          ) ||
          !event.references.some(
            (ref) =>
              ref.kind === "processing_consent" &&
              ref.id === candidate.consentId &&
              ref.revision === candidate.consentVersion,
          )
        )
          throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
      }
      const inserted = await db.query(
        "INSERT INTO capture_processing_publications(workspace_id,capture_id,meeting_id,consent_id,consent_version,transcript_revision,state,event_id,rejection_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING capture_id",
        [
          candidate.workspaceId,
          candidate.captureId,
          candidate.meetingId,
          candidate.consentId,
          candidate.consentVersion,
          candidate.transcriptRevision,
          "event" in decision ? "published" : "rejected",
          "event" in decision ? decision.event.eventId : null,
          "rejectionCode" in decision ? decision.rejectionCode : null,
        ],
      );
      if (inserted.rowCount && "event" in decision)
        await db.query("INSERT INTO outbox(workspace_id,id,event) VALUES($1,$2,$3)", [
          candidate.workspaceId,
          decision.event.eventId,
          decision.event,
        ]);
      await db.query(
        "DELETE FROM capture_processing_publish_index WHERE workspace_id=$1 AND capture_id=$2",
        [candidate.workspaceId, candidate.captureId],
      );
    });
  }
  defer(workspaceId: string, captureId: string) {
    return this.scoped(workspaceId, async (db) => {
      await db.query(
        "UPDATE capture_processing_publish_index SET next_at=now()+interval '30 seconds' WHERE workspace_id=$1 AND capture_id=$2",
        [workspaceId, captureId],
      );
    });
  }
}
