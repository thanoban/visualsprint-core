import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { id, type DomainEvent } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import {
  finalizedCaptureProof,
  type CaptureExtractionJobs,
  type CaptureExtractionJob,
  type FinalizedCaptureProof,
  type ExtractionChunkOutput,
} from "../application/capture-extraction.js";
import { modelClaims } from "../application/schemas.js";
import type { Result } from "../domain/evidence.js";

function view(row: Record<string, unknown>): CaptureExtractionJob {
  return {
    id: String(row.id),
    proof: finalizedCaptureProof.parse(row.proof),
    status: row.status as CaptureExtractionJob["status"],
    attempts: Number(row.attempts),
    completedChunks: Number(row.completed_chunks ?? 0),
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    leaseUntil: row.lease_until as Date | null,
    result: row.result as Result | null,
    errorCode: row.error_code === null ? null : String(row.error_code),
    createdAt: row.created_at as Date,
  };
}
export class PostgresCaptureExtractions implements CaptureExtractionJobs {
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
  private async live(db: pg.PoolClient, proof: FinalizedCaptureProof) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${proof.workspaceId}:delete:${proof.meetingId}`,
    ]);
    if (
      (
        await db.query(
          "SELECT 1 FROM deletion_tombstones WHERE workspace_id=$1 AND meeting_id=$2",
          [proof.workspaceId, proof.meetingId],
        )
      ).rows.length
    )
      throw new AppError("SOURCE_DELETED", 409);
  }
  accept(event: DomainEvent, proof: FinalizedCaptureProof) {
    return this.scoped(proof.workspaceId, async (db) => {
      if (
        event.workspaceId !== proof.workspaceId ||
        event.actorId !== proof.ownerId ||
        event.aggregateId !== proof.captureId ||
        event.aggregateVersion !== proof.transcriptRevision
      )
        throw new AppError("PROCESSING_SCOPE_MISMATCH", 403);
      await this.live(db, proof);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${proof.workspaceId}:capture-extraction:${event.eventId}`,
      ]);
      const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
      const old = (
        await db.query(
          "SELECT digest,job_id,rejection_code FROM capture_extraction_inbox WHERE workspace_id=$1 AND event_id=$2",
          [proof.workspaceId, event.eventId],
        )
      ).rows[0];
      if (old) {
        if (old.digest !== digest) throw new AppError("EVENT_REPLAY_CONFLICT", 409);
        return old.rejection_code
          ? { id: null, rejected: true as const }
          : { id: String(old.job_id) };
      }
      const jobId = randomUUID();
      const inserted = await db.query(
        "INSERT INTO capture_extraction_jobs(workspace_id,id,owner_id,meeting_id,capture_id,consent_id,consent_version,transcript_revision,proof,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued') ON CONFLICT(workspace_id,capture_id,consent_id,consent_version,transcript_revision) DO NOTHING RETURNING id",
        [
          proof.workspaceId,
          jobId,
          proof.ownerId,
          proof.meetingId,
          proof.captureId,
          proof.consentId,
          proof.consentVersion,
          proof.transcriptRevision,
          proof,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await db.query(
            "SELECT id,proof FROM capture_extraction_jobs WHERE workspace_id=$1 AND capture_id=$2 AND consent_id=$3 AND consent_version=$4 AND transcript_revision=$5",
            [
              proof.workspaceId,
              proof.captureId,
              proof.consentId,
              proof.consentVersion,
              proof.transcriptRevision,
            ],
          )
        ).rows[0];
      if (
        !row ||
        (row.proof &&
          JSON.stringify(finalizedCaptureProof.parse(row.proof)) !== JSON.stringify(proof))
      )
        throw new AppError("PROCESSING_SCOPE_MISMATCH", 409);
      await db.query(
        "INSERT INTO capture_extraction_inbox(workspace_id,event_id,digest,job_id,meeting_id) VALUES($1,$2,$3,$4,$5)",
        [proof.workspaceId, event.eventId, digest, row.id, proof.meetingId],
      );
      if (inserted.rowCount)
        await db.query(
          "INSERT INTO capture_extraction_work_index(workspace_id,job_id) VALUES($1,$2)",
          [proof.workspaceId, row.id],
        );
      return { id: String(row.id) };
    });
  }
  reject(event: DomainEvent, proof: FinalizedCaptureProof, code: string) {
    return this.scoped(proof.workspaceId, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${proof.workspaceId}:delete:${proof.meetingId}`,
      ]);
      // The permanent deletion barrier is already a durable rejection. Do not
      // recreate even inbox/routing records after the deletion acknowledgement.
      if (
        (
          await db.query(
            "SELECT 1 FROM deletion_tombstones WHERE workspace_id=$1 AND meeting_id=$2",
            [proof.workspaceId, proof.meetingId],
          )
        ).rows.length
      )
        return;
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${proof.workspaceId}:capture-extraction:${event.eventId}`,
      ]);
      const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
      const prior = (
        await db.query(
          "SELECT digest,job_id FROM capture_extraction_inbox WHERE workspace_id=$1 AND event_id=$2",
          [proof.workspaceId, event.eventId],
        )
      ).rows[0];
      if (prior) {
        if (prior.digest !== digest) throw new AppError("EVENT_REPLAY_CONFLICT", 409);
        if (prior.job_id) {
          await db.query(
            "UPDATE capture_extraction_jobs SET status='failed',result=NULL,error_code=$3,lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','running')",
            [proof.workspaceId, prior.job_id, code],
          );
          await db.query(
            "DELETE FROM capture_extraction_work_index w WHERE workspace_id=$1 AND job_id=$2 AND NOT EXISTS(SELECT 1 FROM capture_extraction_jobs j WHERE j.workspace_id=w.workspace_id AND j.id=w.job_id AND j.status IN ('queued','running'))",
            [proof.workspaceId, prior.job_id],
          );
        }
        return;
      }
      await db.query(
        "INSERT INTO capture_extraction_inbox(workspace_id,event_id,digest,meeting_id,rejection_code) VALUES($1,$2,$3,$4,$5)",
        [proof.workspaceId, event.eventId, digest, proof.meetingId, code],
      );
    });
  }
  async due() {
    return (
      await this.pool.query(
        "SELECT workspace_id,job_id FROM capture_extraction_work_index WHERE next_at<=now() ORDER BY next_at,workspace_id,job_id LIMIT 20",
      )
    ).rows.map((row) => ({ workspaceId: id.parse(row.workspace_id), id: id.parse(row.job_id) }));
  }
  claim(workspaceId: string, jobId: string) {
    return this.scoped(workspaceId, async (db) => {
      const row = (
        await db.query(
          "UPDATE capture_extraction_jobs SET status='running',attempts=attempts+1,lease_token=$3,lease_until=now()+interval '300 seconds' WHERE workspace_id=$1 AND id=$2 AND (status='queued' OR (status='running' AND lease_until<now())) RETURNING *,COALESCE((SELECT jsonb_array_length(c.outputs) FROM capture_extraction_chunks c WHERE c.workspace_id=capture_extraction_jobs.workspace_id AND c.job_id=capture_extraction_jobs.id),0) AS completed_chunks",
          [workspaceId, id.parse(jobId), randomUUID()],
        )
      ).rows[0];
      return row ? view(row) : null;
    });
  }
  private async fenced(db: pg.PoolClient, job: CaptureExtractionJob) {
    await this.live(db, job.proof);
    if (
      !(
        await db.query(
          "SELECT 1 FROM capture_extraction_jobs WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND status='running' AND lease_token=$4 AND lease_until>now()+interval '60 seconds' FOR UPDATE",
          [job.proof.workspaceId, job.id, job.proof.ownerId, job.leaseToken],
        )
      ).rows.length
    )
      throw new AppError("EXTRACTION_LEASE_LOST", 409);
  }
  guard(job: CaptureExtractionJob) {
    return this.scoped(job.proof.workspaceId, (db) => this.fenced(db, job));
  }
  chunks(job: CaptureExtractionJob, plan: string, count: number) {
    return this.scoped(job.proof.workspaceId, async (db) => {
      await this.fenced(db, job);
      await db.query(
        "INSERT INTO capture_extraction_chunks(workspace_id,job_id,source_fingerprint,chunk_count) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [job.proof.workspaceId, job.id, plan, count],
      );
      const row = (
        await db.query(
          "SELECT source_fingerprint,chunk_count,outputs FROM capture_extraction_chunks WHERE workspace_id=$1 AND job_id=$2",
          [job.proof.workspaceId, job.id],
        )
      ).rows[0];
      if (
        !row ||
        row.source_fingerprint !== plan ||
        row.chunk_count !== count ||
        !Array.isArray(row.outputs) ||
        row.outputs.length > count
      )
        throw new AppError("SOURCE_CHANGED", 409);
      return row.outputs.map((output: unknown) => modelClaims.parse(output));
    });
  }
  checkpoint(
    job: CaptureExtractionJob,
    plan: string,
    index: number,
    output: ExtractionChunkOutput,
  ) {
    return this.scoped(job.proof.workspaceId, async (db) => {
      await this.fenced(db, job);
      const result = await db.query(
        "UPDATE capture_extraction_chunks SET outputs=outputs || $5::jsonb WHERE workspace_id=$1 AND job_id=$2 AND source_fingerprint=$3 AND jsonb_array_length(outputs)=$4 AND chunk_count>$4 RETURNING job_id",
        [job.proof.workspaceId, job.id, plan, index, JSON.stringify([modelClaims.parse(output)])],
      );
      if (!result.rowCount) throw new AppError("EXTRACTION_CHECKPOINT_CONFLICT", 409);
    });
  }
  yield(job: CaptureExtractionJob) {
    return this.scoped(job.proof.workspaceId, async (db) => {
      await this.fenced(db, job);
      await db.query(
        "UPDATE capture_extraction_jobs SET status='queued',error_code=NULL,lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND id=$2",
        [job.proof.workspaceId, job.id],
      );
      await db.query(
        "UPDATE capture_extraction_work_index SET next_at=now() WHERE workspace_id=$1 AND job_id=$2",
        [job.proof.workspaceId, job.id],
      );
    });
  }
  complete(job: CaptureExtractionJob, result: Result) {
    return this.scoped(job.proof.workspaceId, async (db) => {
      await this.fenced(db, job);
      await db.query(
        "UPDATE capture_extraction_jobs SET status='complete',result=$3,error_code=NULL,lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND id=$2",
        [job.proof.workspaceId, job.id, result],
      );
      await db.query(
        "DELETE FROM capture_extraction_work_index WHERE workspace_id=$1 AND job_id=$2",
        [job.proof.workspaceId, job.id],
      );
    });
  }
  fail(job: CaptureExtractionJob, code: string, retry: boolean) {
    return this.scoped(job.proof.workspaceId, async (db) => {
      const result = await db.query(
        "UPDATE capture_extraction_jobs SET status=$4,error_code=$5,lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='running' RETURNING id",
        [job.proof.workspaceId, job.id, job.leaseToken, retry ? "queued" : "failed", code],
      );
      if (!result.rowCount) return;
      if (retry)
        await db.query(
          "UPDATE capture_extraction_work_index SET next_at=now()+interval '30 seconds' WHERE workspace_id=$1 AND job_id=$2",
          [job.proof.workspaceId, job.id],
        );
      else
        await db.query(
          "DELETE FROM capture_extraction_work_index WHERE workspace_id=$1 AND job_id=$2",
          [job.proof.workspaceId, job.id],
        );
    });
  }
  load(actor: Actor, jobId: string) {
    return this.scoped(actor.workspaceId, async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM capture_extraction_jobs WHERE workspace_id=$1 AND id=$2 AND owner_id=$3",
          [actor.workspaceId, id.parse(jobId), actor.actorId],
        )
      ).rows[0];
      return row ? view(row) : null;
    });
  }
  list(actor: Actor, meetingId: string) {
    return this.scoped(actor.workspaceId, async (db) => {
      const rows = (
        await db.query(
          "SELECT * FROM capture_extraction_jobs WHERE workspace_id=$1 AND meeting_id=$2 AND owner_id=$3 ORDER BY created_at,id LIMIT 101",
          [actor.workspaceId, id.parse(meetingId), actor.actorId],
        )
      ).rows;
      if (rows.length > 100) throw new AppError("EXTRACTION_SCOPE_TOO_LARGE", 409);
      return rows.map(view);
    });
  }
  invalidate(job: CaptureExtractionJob) {
    return this.scoped(job.proof.workspaceId, async (db) => {
      await db.query(
        "UPDATE capture_extraction_jobs SET status='invalidated',result=NULL,error_code='SOURCE_CHANGED' WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND status='complete'",
        [job.proof.workspaceId, job.id, job.proof.ownerId],
      );
    });
  }
  purgeMeeting(workspaceId: string, meetingId: string) {
    return this.scoped(workspaceId, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${workspaceId}:delete:${id.parse(meetingId)}`,
      ]);
      if (
        !(
          await db.query(
            "SELECT 1 FROM deletion_tombstones WHERE workspace_id=$1 AND meeting_id=$2",
            [workspaceId, meetingId],
          )
        ).rows.length
      )
        throw new AppError("DELETION_BARRIER_REQUIRED", 409);
      await db.query(
        "DELETE FROM capture_extraction_jobs WHERE workspace_id=$1 AND meeting_id=$2",
        [workspaceId, meetingId],
      );
      await db.query(
        "DELETE FROM capture_extraction_inbox WHERE workspace_id=$1 AND meeting_id=$2",
        [workspaceId, meetingId],
      );
    });
  }
}
