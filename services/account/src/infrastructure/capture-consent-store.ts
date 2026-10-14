import { randomUUID, createHash } from "node:crypto";
import type pg from "pg";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type {
  CaptureConsent,
  CaptureConsentRepository,
  ConsentBinding,
} from "../application/capture-consent.js";
function view(row: Record<string, unknown>): CaptureConsent {
  return {
    consentId: String(row.consent_id),
    workspaceId: String(row.workspace_id),
    ownerId: String(row.owner_id),
    meetingId: String(row.meeting_id),
    captureId: String(row.capture_id),
    version: Number(row.version),
    policyVersion: "english-text-v1",
    active: row.active === true,
    createdAt: row.created_at as Date,
  };
}
export class PostgresCaptureConsents implements CaptureConsentRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async scoped<T>(
    actor: Pick<Actor, "workspaceId" | "actorId">,
    work: (client: pg.PoolClient) => Promise<T>,
  ) {
    id.parse(actor.workspaceId);
    id.parse(actor.actorId);
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
        [actor.workspaceId, actor.actorId],
      );
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
  private async current(db: pg.PoolClient, actor: Actor, session: boolean) {
    const result = await db.query(
      `SELECT 1 FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.active AND NOT w.blocked
      AND (NOT $4::boolean OR NOT EXISTS(SELECT 1 FROM revoked_sessions WHERE user_id=$2 AND session_id=$3))`,
      [actor.workspaceId, actor.actorId, actor.sessionId, session],
    );
    if (!result.rows.length) throw new AppError("FORBIDDEN", 403);
  }
  requireCurrent(actor: Actor, session: boolean) {
    return this.scoped(actor, (db) => this.current(db, actor, session));
  }
  private async meetingLock(db: pg.PoolClient, workspaceId: string, meetingId: string) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${workspaceId}:processing-meeting:${meetingId}`,
    ]);
    const deleted = await db.query(
      "SELECT 1 FROM capture_processing_deletions WHERE workspace_id=$1 AND meeting_id=$2",
      [workspaceId, meetingId],
    );
    if (deleted.rows.length) throw new AppError("SOURCE_DELETED", 409);
  }
  create(actor: Actor, key: string, input: Parameters<CaptureConsentRepository["create"]>[2]) {
    return this.scoped(actor, async (db) => {
      await this.current(db, actor, true);
      await this.meetingLock(db, actor.workspaceId, input.meetingId);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${actor.workspaceId}:processing-command:${actor.actorId}:${key}`,
      ]);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${actor.workspaceId}:processing-capture:${input.captureId}`,
      ]);
      if (
        (
          await db.query(
            "SELECT 1 FROM capture_processing_withdrawals WHERE workspace_id=$1 AND capture_id=$2",
            [actor.workspaceId, input.captureId],
          )
        ).rows.length
      )
        throw new AppError("CONSENT_WITHDRAWN", 409);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["create", input]))
        .digest("hex");
      const old = await db.query(
        "SELECT * FROM capture_processing_commands WHERE workspace_id=$1 AND owner_id=$2 AND key=$3",
        [actor.workspaceId, actor.actorId, key],
      );
      if (old.rows[0] && old.rows[0].fingerprint !== fingerprint)
        throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      let row = (
        await db.query(
          "SELECT * FROM capture_processing_consents WHERE workspace_id=$1 AND capture_id=$2 FOR UPDATE",
          [actor.workspaceId, input.captureId],
        )
      ).rows[0];
      if (
        row &&
        (row.owner_id !== actor.actorId ||
          row.meeting_id !== input.meetingId ||
          row.policy_version !== input.policyVersion)
      )
        throw new AppError("CONSENT_BINDING_CONFLICT", 409);
      if (row && !row.active) throw new AppError("CONSENT_WITHDRAWN", 409);
      if (!row)
        row = (
          await db.query(
            "INSERT INTO capture_processing_consents(workspace_id,consent_id,owner_id,meeting_id,capture_id,policy_version) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              actor.workspaceId,
              randomUUID(),
              actor.actorId,
              input.meetingId,
              input.captureId,
              input.policyVersion,
            ],
          )
        ).rows[0];
      if (!old.rows.length)
        await db.query(
          "INSERT INTO capture_processing_commands(workspace_id,owner_id,key,fingerprint,consent_id) VALUES($1,$2,$3,$4,$5)",
          [actor.workspaceId, actor.actorId, key, fingerprint, row.consent_id],
        );
      await this.current(db, actor, true);
      return view(row);
    });
  }
  authorize(actor: Actor, binding: ConsentBinding) {
    return this.scoped(actor, async (db) => {
      await this.current(db, actor, false);
      await this.meetingLock(db, actor.workspaceId, binding.meetingId);
      const row = (
        await db.query(
          "SELECT * FROM capture_processing_consents WHERE workspace_id=$1 AND consent_id=$2",
          [actor.workspaceId, binding.consentId],
        )
      ).rows[0];
      if (
        !row ||
        !row.active ||
        row.owner_id !== actor.actorId ||
        row.capture_id !== binding.captureId ||
        row.meeting_id !== binding.meetingId ||
        row.version !== binding.expectedVersion ||
        row.policy_version !== binding.policyVersion
      )
        throw new AppError("FORBIDDEN", 403);
      await this.current(db, actor, false);
      return view(row);
    });
  }
  list(actor: Actor, captureId?: string) {
    return this.scoped(actor, async (db) => {
      await this.current(db, actor, true);
      const result = await db.query(
        "SELECT * FROM capture_processing_consents WHERE workspace_id=$1 AND owner_id=$2 AND ($3::uuid IS NULL OR capture_id=$3) ORDER BY created_at,consent_id LIMIT 101",
        [actor.workspaceId, actor.actorId, captureId ?? null],
      );
      if (result.rows.length > 100) throw new AppError("CONSENTS_SCOPE_TOO_LARGE", 409);
      return result.rows.map(view);
    });
  }
  revoke(actor: Actor, key: string, consentId: string, expectedVersion: number) {
    return this.scoped(actor, async (db) => {
      await this.current(db, actor, true);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${actor.workspaceId}:processing-command:${actor.actorId}:${key}`,
      ]);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${actor.workspaceId}:processing-revoke:${consentId}`,
      ]);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["revoke", consentId, expectedVersion]))
        .digest("hex");
      const old = (
        await db.query(
          "SELECT * FROM capture_processing_commands WHERE workspace_id=$1 AND owner_id=$2 AND key=$3",
          [actor.workspaceId, actor.actorId, key],
        )
      ).rows[0];
      if (old && old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      let row = (
        await db.query(
          "SELECT * FROM capture_processing_consents WHERE workspace_id=$1 AND consent_id=$2 AND owner_id=$3 FOR UPDATE",
          [actor.workspaceId, consentId, actor.actorId],
        )
      ).rows[0];
      if (!row) throw new AppError("NOT_FOUND", 404);
      if (!old) {
        if (row.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", 409);
        if (row.active)
          row = (
            await db.query(
              "UPDATE capture_processing_consents SET active=false,version=version+1 WHERE workspace_id=$1 AND consent_id=$2 RETURNING *",
              [actor.workspaceId, consentId],
            )
          ).rows[0];
        await db.query(
          "INSERT INTO capture_processing_commands(workspace_id,owner_id,key,fingerprint,consent_id) VALUES($1,$2,$3,$4,$5)",
          [actor.workspaceId, actor.actorId, key, fingerprint, consentId],
        );
      }
      return view(row);
    });
  }
  deleteMeeting(workspaceId: string, meetingId: string, deletionId: string, sourceVersion: number) {
    return this.scoped({ workspaceId, actorId: deletionId }, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${workspaceId}:processing-meeting:${meetingId}`,
      ]);
      const old = await db.query(
        "SELECT * FROM capture_processing_deletions WHERE workspace_id=$1 AND (meeting_id=$2 OR deletion_id=$3)",
        [workspaceId, meetingId, deletionId],
      );
      if (
        old.rows.some(
          (row) =>
            row.meeting_id !== meetingId ||
            row.deletion_id !== deletionId ||
            row.source_version !== sourceVersion,
        )
      )
        throw new AppError("DELETION_CONFLICT", 409);
      await db.query(
        "INSERT INTO capture_processing_deletions(workspace_id,meeting_id,deletion_id,source_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [workspaceId, meetingId, deletionId, sourceVersion],
      );
      await db.query(
        "UPDATE capture_processing_consents SET active=false,version=version+1 WHERE workspace_id=$1 AND meeting_id=$2 AND active",
        [workspaceId, meetingId],
      );
    });
  }
  withdrawCapture(actor: Actor, input: Parameters<CaptureConsentRepository["withdrawCapture"]>[1]) {
    return this.scoped(actor, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${actor.workspaceId}:processing-capture:${input.captureId}`,
      ]);
      const old = (
        await db.query(
          "SELECT * FROM capture_processing_withdrawals WHERE workspace_id=$1 AND capture_id=$2",
          [actor.workspaceId, input.captureId],
        )
      ).rows[0];
      if (
        old &&
        (old.meeting_id !== input.meetingId ||
          old.owner_id !== actor.actorId ||
          old.policy_version !== input.policyVersion)
      )
        throw new AppError("CONSENT_BINDING_CONFLICT", 409);
      let row = (
        await db.query(
          "SELECT * FROM capture_processing_consents WHERE workspace_id=$1 AND capture_id=$2 FOR UPDATE",
          [actor.workspaceId, input.captureId],
        )
      ).rows[0];
      if (
        row &&
        (row.owner_id !== actor.actorId ||
          row.meeting_id !== input.meetingId ||
          row.policy_version !== input.policyVersion)
      )
        throw new AppError("CONSENT_BINDING_CONFLICT", 409);
      await db.query(
        "INSERT INTO capture_processing_withdrawals(workspace_id,capture_id,meeting_id,owner_id,policy_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [actor.workspaceId, input.captureId, input.meetingId, actor.actorId, input.policyVersion],
      );
      if (row?.active)
        row = (
          await db.query(
            "UPDATE capture_processing_consents SET active=false,version=version+1 WHERE workspace_id=$1 AND capture_id=$2 RETURNING *",
            [actor.workspaceId, input.captureId],
          )
        ).rows[0];
      return {
        captureId: input.captureId,
        meetingId: input.meetingId,
        consentId: row ? String(row.consent_id) : null,
        version: row ? Number(row.version) : null,
        active: false as const,
        creationBlocked: true as const,
      };
    });
  }
}
