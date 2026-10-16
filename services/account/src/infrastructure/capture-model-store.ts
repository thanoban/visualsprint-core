import type pg from "pg";
import { AppError, type Actor } from "@visualsprint/platform";
import { id } from "@visualsprint/contracts";
import { ModelTx } from "./model-usage-store.js";
import {
  captureModelFingerprint,
  type CaptureModelRepository,
  type CaptureModelTransaction,
  type CaptureModelRequest,
} from "../application/capture-model-usage.js";
class CaptureModelTx extends ModelTx implements CaptureModelTransaction {
  constructor(
    private readonly captureDb: pg.PoolClient,
    private readonly captureActor: Actor,
  ) {
    super(captureDb, captureActor);
  }
  async requireCapture(input: CaptureModelRequest) {
    const db = this.captureDb,
      actor = this.captureActor;
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${actor.workspaceId}:processing-meeting:${input.proof.meetingId}`,
    ]);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${actor.workspaceId}:processing-capture:${input.proof.captureId}`,
    ]);
    const row = (
      await db.query(
        `SELECT c.consent_id FROM capture_processing_consents c
 JOIN memberships m ON m.workspace_id=c.workspace_id AND m.user_id=c.owner_id JOIN workspaces w ON w.id=m.workspace_id
 WHERE c.workspace_id=$1 AND c.owner_id=$2 AND c.consent_id=$3 AND c.version=$4 AND c.meeting_id=$5 AND c.capture_id=$6 AND c.policy_version=$7 AND c.active AND m.active AND NOT w.blocked
 AND NOT EXISTS(SELECT 1 FROM capture_processing_deletions d WHERE d.workspace_id=c.workspace_id AND d.meeting_id=c.meeting_id)
 AND NOT EXISTS(SELECT 1 FROM capture_processing_withdrawals d WHERE d.workspace_id=c.workspace_id AND d.capture_id=c.capture_id)
 FOR SHARE OF c,m,w`,
        [
          actor.workspaceId,
          actor.actorId,
          input.proof.consentId,
          input.proof.expectedVersion,
          input.proof.meetingId,
          input.proof.captureId,
          input.proof.policyVersion,
        ],
      )
    ).rows[0];
    if (!row) throw new AppError("FORBIDDEN", 403);
  }
  async binding(reservationId: string) {
    const row = (
      await this.captureDb.query(
        "SELECT * FROM capture_model_bindings WHERE workspace_id=$1 AND reservation_id=$2",
        [this.captureActor.workspaceId, reservationId],
      )
    ).rows[0];
    return row
      ? {
          reservationId: String(row.reservation_id),
          operationId: String(row.operation_id),
          ownerId: String(row.owner_id),
          consentId: String(row.consent_id),
          fingerprint: String(row.fingerprint),
        }
      : undefined;
  }
  async bind(reservationId: string, input: CaptureModelRequest) {
    await this.captureDb.query(
      "INSERT INTO capture_model_bindings(workspace_id,reservation_id,operation_id,owner_id,consent_id,consent_version,meeting_id,capture_id,policy_version,transcript_revision,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        this.captureActor.workspaceId,
        reservationId,
        input.operationId,
        this.captureActor.actorId,
        input.proof.consentId,
        input.proof.expectedVersion,
        input.proof.meetingId,
        input.proof.captureId,
        input.proof.policyVersion,
        input.transcriptRevision,
        captureModelFingerprint(input),
      ],
    );
  }
}
export class PostgresCaptureModelUsage implements CaptureModelRepository {
  constructor(private readonly pool: pg.Pool) {}
  async transaction<T>(actor: Actor, work: (tx: CaptureModelTransaction) => Promise<T>) {
    id.parse(actor.workspaceId);
    id.parse(actor.actorId);
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
        [actor.workspaceId, actor.actorId],
      );
      const result = await work(new CaptureModelTx(db, actor));
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
}
