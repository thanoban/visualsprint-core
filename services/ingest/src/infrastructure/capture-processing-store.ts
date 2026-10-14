import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type {
  ProcessingRepository,
  ProcessingIntent,
  ProcessingCapture,
} from "../application/capture-processing.js";
const intentView = (row: Record<string, unknown>): ProcessingIntent => ({
  workspaceId: String(row.workspace_id),
  captureId: String(row.capture_id),
  meetingId: String(row.meeting_id),
  ownerId: String(row.owner_id),
  intentVersion: Number(row.intent_version),
  policyVersion: "english-text-v1",
  state: row.state as ProcessingIntent["state"],
  consentId: row.consent_id === null ? null : String(row.consent_id),
  consentVersion: row.consent_version === null ? null : Number(row.consent_version),
  errorCode: row.error_code === null ? null : String(row.error_code),
});
export class PostgresCaptureProcessing implements ProcessingRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async scoped<T>(workspaceId: string, work: (db: pg.PoolClient) => Promise<T>) {
    id.parse(workspaceId);
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
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
  capture(workspaceId: string, captureId: string) {
    return this.scoped(workspaceId, async (db) => {
      const row = (
        await db.query(
          `SELECT c.id,c.meeting_id,c.owner_id,c.state,c.transcript_revision,c.coverage,
      EXISTS(SELECT 1 FROM meeting_deletions d WHERE d.workspace_id=c.workspace_id AND d.meeting_id=c.meeting_id) AS deleted
      FROM capture_requests c WHERE c.workspace_id=$1 AND c.id=$2`,
          [workspaceId, id.parse(captureId)],
        )
      ).rows[0];
      return row
        ? {
            captureId: String(row.id),
            meetingId: String(row.meeting_id),
            ownerId: String(row.owner_id),
            state: String(row.state),
            transcriptRevision: Number(row.transcript_revision),
            coverage: String(row.coverage),
            deleted: row.deleted === true,
          }
        : null;
    });
  }
  intent(workspaceId: string, captureId: string) {
    return this.scoped(workspaceId, async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM capture_processing_intents WHERE workspace_id=$1 AND capture_id=$2",
          [workspaceId, id.parse(captureId)],
        )
      ).rows[0];
      return row ? intentView(row) : null;
    });
  }
  private async command(
    db: pg.PoolClient,
    actor: Actor,
    key: string,
    input: unknown,
    captureId: string,
  ) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${actor.workspaceId}:processing-command:${actor.actorId}:${key}`,
    ]);
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      row = (
        await db.query(
          "SELECT * FROM capture_processing_commands WHERE workspace_id=$1 AND owner_id=$2 AND key=$3",
          [actor.workspaceId, actor.actorId, key],
        )
      ).rows[0];
    if (row && (row.fingerprint !== hash || row.capture_id !== captureId))
      throw new AppError("IDEMPOTENCY_CONFLICT", 409);
    return { hash, replay: Boolean(row) };
  }
  create(actor: Actor, key: string, capture: ProcessingCapture) {
    return this.scoped(actor.workspaceId, async (db) => {
      const command = await this.command(
        db,
        actor,
        key,
        ["consent", capture.captureId, "english-text-v1"],
        capture.captureId,
      );
      const owned = (
        await db.query(
          `SELECT 1 FROM capture_requests c WHERE c.workspace_id=$1 AND c.id=$2 AND c.owner_id=$3
      AND NOT EXISTS(SELECT 1 FROM meeting_deletions d WHERE d.workspace_id=$1 AND d.meeting_id=c.meeting_id) FOR UPDATE`,
          [actor.workspaceId, capture.captureId, actor.actorId],
        )
      ).rows[0];
      if (!owned) throw new AppError("NOT_FOUND", 404);
      let row = (
        await db.query(
          "SELECT * FROM capture_processing_intents WHERE workspace_id=$1 AND capture_id=$2 FOR UPDATE",
          [actor.workspaceId, capture.captureId],
        )
      ).rows[0];
      if (!row)
        row = (
          await db.query(
            "INSERT INTO capture_processing_intents(workspace_id,capture_id,meeting_id,owner_id,policy_version,state) VALUES($1,$2,$3,$4,'english-text-v1','consent_pending') RETURNING *",
            [actor.workspaceId, capture.captureId, capture.meetingId, actor.actorId],
          )
        ).rows[0];
      if (!command.replay)
        await db.query(
          "INSERT INTO capture_processing_commands(workspace_id,owner_id,key,fingerprint,capture_id) VALUES($1,$2,$3,$4,$5)",
          [actor.workspaceId, actor.actorId, key, command.hash, capture.captureId],
        );
      return intentView(row);
    });
  }
  bind(intent: ProcessingIntent, grant: { consentId: string; version: number }) {
    return this.scoped(intent.workspaceId, async (db) => {
      id.parse(grant.consentId);
      if (!Number.isInteger(grant.version) || grant.version < 1)
        throw new AppError("INVALID_CONSENT_BINDING", 503);
      const row = (
        await db.query(
          "SELECT * FROM capture_processing_intents WHERE workspace_id=$1 AND capture_id=$2 FOR UPDATE",
          [intent.workspaceId, intent.captureId],
        )
      ).rows[0];
      if (!row || row.owner_id !== intent.ownerId || row.meeting_id !== intent.meetingId)
        throw new AppError("CONSENT_BINDING_CONFLICT", 409);
      if (
        row.consent_id &&
        (row.consent_id !== grant.consentId || row.consent_version !== grant.version)
      )
        throw new AppError("CONSENT_BINDING_CONFLICT", 409);
      // Keep a late grant reference for mandatory cleanup, but never let its ACK
      // reactivate an intent withdrawn while Account creation was in flight.
      const ready =
        row.intent_version === intent.intentVersion &&
        ["consent_pending", "configuration_error"].includes(row.state);
      const updated = (
        await db.query(
          "UPDATE capture_processing_intents SET consent_id=$3,consent_version=$4,state=CASE WHEN $5 THEN 'ready' ELSE state END,error_code=CASE WHEN $5 THEN NULL ELSE error_code END WHERE workspace_id=$1 AND capture_id=$2 RETURNING *",
          [intent.workspaceId, intent.captureId, grant.consentId, grant.version, ready],
        )
      ).rows[0];
      return intentView(updated);
    });
  }
  withdraw(actor: Actor, key: string, captureId: string, expectedIntentVersion: number) {
    return this.scoped(actor.workspaceId, async (db) => {
      const command = await this.command(
        db,
        actor,
        key,
        ["withdraw", captureId, expectedIntentVersion],
        captureId,
      );
      const row = (
        await db.query(
          "SELECT * FROM capture_processing_intents WHERE workspace_id=$1 AND capture_id=$2 AND owner_id=$3 FOR UPDATE",
          [actor.workspaceId, captureId, actor.actorId],
        )
      ).rows[0];
      if (!row) throw new AppError("NOT_FOUND", 404);
      let result = row;
      if (!command.replay) {
        if (row.intent_version !== expectedIntentVersion)
          throw new AppError("VERSION_CONFLICT", 409);
        if (!["withdraw_requested", "revoked"].includes(row.state))
          result = (
            await db.query(
              "UPDATE capture_processing_intents SET state='withdraw_requested',intent_version=intent_version+1 WHERE workspace_id=$1 AND capture_id=$2 RETURNING *",
              [actor.workspaceId, captureId],
            )
          ).rows[0];
        await db.query(
          "INSERT INTO capture_processing_commands(workspace_id,owner_id,key,fingerprint,capture_id) VALUES($1,$2,$3,$4,$5)",
          [actor.workspaceId, actor.actorId, key, command.hash, captureId],
        );
      }
      return intentView(result);
    });
  }
  page(workspaceId: string, captureId: string, cursor?: string) {
    return this.scoped(workspaceId, async (db) => {
      let position: [number, string] | null = null;
      if (cursor) {
        try {
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(cursor)) throw new Error();
          position = z
            .tuple([z.number().int().nonnegative(), id])
            .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
        } catch {
          throw new AppError("INVALID_CURSOR", 400);
        }
      }
      const result = await db.query(
        "SELECT * FROM transcript_segments WHERE workspace_id=$1 AND request_id=$2 AND ($3::integer IS NULL OR (start_ms,id)>($3,$4::uuid)) ORDER BY start_ms,id LIMIT 101",
        [workspaceId, captureId, position?.[0] ?? null, position?.[1] ?? null],
      );
      const rows = result.rows.slice(0, 100),
        last = rows.at(-1),
        stats = (
          await db.query(
            "SELECT count(*)::integer AS count,coalesce(sum(octet_length(text)),0) AS bytes FROM transcript_segments WHERE workspace_id=$1 AND request_id=$2",
            [workspaceId, captureId],
          )
        ).rows[0];
      return {
        segments: rows.map((row) => ({
          id: String(row.id),
          revision: Number(row.revision),
          startMs: Number(row.start_ms),
          endMs: Number(row.end_ms),
          text: String(row.text),
          speakerLabel: row.speaker_label === null ? null : String(row.speaker_label),
          finalized: row.finalized === true,
        })),
        totalSegments: Number(stats.count),
        totalBytes: Number(stats.bytes),
        nextCursor:
          result.rows.length > 100 && last
            ? Buffer.from(JSON.stringify([last.start_ms, last.id])).toString("base64url")
            : null,
      };
    });
  }
  finishWithdrawal(
    intent: ProcessingIntent,
    result: Parameters<ProcessingRepository["finishWithdrawal"]>[1],
  ) {
    return this.scoped(intent.workspaceId, async (db) => {
      if (
        result.captureId !== intent.captureId ||
        result.meetingId !== intent.meetingId ||
        !result.creationBlocked ||
        result.active ||
        (result.consentId === null) !== (result.version === null)
      )
        throw new AppError("INVALID_WITHDRAWAL_ACK", 503);
      const row = (
        await db.query(
          "SELECT * FROM capture_processing_intents WHERE workspace_id=$1 AND capture_id=$2 FOR UPDATE",
          [intent.workspaceId, intent.captureId],
        )
      ).rows[0];
      if (
        !row ||
        row.owner_id !== intent.ownerId ||
        row.intent_version !== intent.intentVersion ||
        !["withdraw_requested", "revoked"].includes(row.state)
      )
        throw new AppError("PROCESSING_CONTEXT_CHANGED", 409);
      if (row.consent_id && row.consent_id !== result.consentId)
        throw new AppError("INVALID_WITHDRAWAL_ACK", 503);
      const updated = (
        await db.query(
          "UPDATE capture_processing_intents SET state='revoked',consent_id=$3,consent_version=$4,error_code=NULL WHERE workspace_id=$1 AND capture_id=$2 RETURNING *",
          [intent.workspaceId, intent.captureId, result.consentId, result.version],
        )
      ).rows[0];
      return intentView(updated);
    });
  }
  async error(intent: ProcessingIntent, code: string) {
    await this.scoped(intent.workspaceId, async (db) => {
      await db.query(
        "UPDATE capture_processing_intents SET error_code=$4,state=CASE WHEN state IN ('consent_pending','configuration_error') THEN 'configuration_error' ELSE state END WHERE workspace_id=$1 AND capture_id=$2 AND intent_version=$3 AND state IN ('consent_pending','configuration_error','withdraw_requested')",
        [intent.workspaceId, intent.captureId, intent.intentVersion, code],
      );
    });
  }
  async deleteMeeting(
    workspaceId: string,
    meetingId: string,
    deletionId: string,
    sourceVersion: number,
  ) {
    await this.scoped(workspaceId, async (db) => {
      const pin = (
        await db.query(
          "SELECT 1 FROM meeting_deletions WHERE workspace_id=$1 AND meeting_id=$2 AND deletion_id=$3 AND source_version=$4",
          [workspaceId, meetingId, deletionId, sourceVersion],
        )
      ).rows[0];
      if (!pin) throw new AppError("DELETION_BARRIER_REQUIRED", 409);
      await db.query(
        "UPDATE capture_processing_intents SET state='revoked',intent_version=intent_version+1,error_code=NULL WHERE workspace_id=$1 AND meeting_id=$2 AND state<>'revoked'",
        [workspaceId, meetingId],
      );
    });
  }
  hasMeetingIntents(workspaceId: string, meetingId: string) {
    return this.scoped(workspaceId, async (db) =>
      Boolean(
        (
          await db.query(
            "SELECT 1 FROM capture_processing_intents WHERE workspace_id=$1 AND meeting_id=$2 LIMIT 1",
            [workspaceId, meetingId],
          )
        ).rows[0],
      ),
    );
  }
}
