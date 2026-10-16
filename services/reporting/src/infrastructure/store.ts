import { randomUUID, createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { AppError, type Actor } from "@visualsprint/platform";
import type { ExportJob, ExportRepository } from "../application/ports.js";
import * as schema from "./schema.js";
type Row = Record<string, unknown>;
const decode = (row: Row): ExportJob => ({
  workspaceId: String(row.workspace_id),
  id: String(row.id),
  meetingId: String(row.meeting_id),
  ownerId: String(row.owner_id),
  sessionId: String(row.session_id),
  format: row.format as ExportJob["format"],
  state: row.state as ExportJob["state"],
  version: Number(row.version),
  attempts: Number(row.attempts),
  fingerprint: row.fingerprint as string | null,
  content: row.content as string | null,
  errorCode: row.error_code as string | null,
  leaseToken: row.lease_token as string | null,
  expiresAt: new Date(row.expires_at as string),
});
const dbFor = (pool: pg.Pool) => drizzle(pool, { schema });
type Tx = Parameters<Parameters<ReturnType<typeof dbFor>["transaction"]>[0]>[0];
export class PostgresExports implements ExportRepository {
  private readonly db;
  constructor(pool: pg.Pool) {
    this.db = dbFor(pool);
  }
  private scoped<T>(workspaceId: string, work: (tx: Tx) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id',${workspaceId},true)`);
      return work(tx);
    });
  }
  private lock(tx: Tx, ws: string, meeting: string) {
    return tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${ws + ":export-meeting:" + meeting},0))`,
    );
  }
  async create(
    actor: Actor,
    key: string,
    input: { meetingId: string; format: "text" | "json" },
    now: Date,
  ) {
    return this.scoped(actor.workspaceId, async (tx) => {
      await this.lock(tx, actor.workspaceId, input.meetingId);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.workspaceId + ":export-command:" + actor.actorId + ":" + key},0))`,
      );
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      if (
        (
          await tx.execute(
            sql`SELECT 1 FROM deletion_tombstones WHERE meeting_id=${input.meetingId}`,
          )
        ).rows.length
      )
        throw new AppError("NOT_FOUND", 404);
      const old = (
        await tx.execute(
          sql`SELECT fingerprint,export_id FROM export_commands WHERE owner_id=${actor.actorId} AND key=${key}`,
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        return decode(
          (await tx.execute(sql`SELECT * FROM exports WHERE id=${old.export_id}`)).rows[0]!,
        );
      }
      const jobId = randomUUID();
      const row = (
        await tx.execute(
          sql`INSERT INTO exports(workspace_id,id,meeting_id,owner_id,session_id,format,state,expires_at) VALUES(${actor.workspaceId},${jobId},${input.meetingId},${actor.actorId},${actor.sessionId},${input.format},'queued',${new Date(now.getTime() + 86400000).toISOString()}) RETURNING *`,
        )
      ).rows[0]!;
      await tx.execute(
        sql`INSERT INTO export_commands(workspace_id,owner_id,key,fingerprint,export_id) VALUES(${actor.workspaceId},${actor.actorId},${key},${fingerprint},${jobId})`,
      );
      await tx.execute(
        sql`INSERT INTO export_work_index(workspace_id,export_id,next_at) VALUES(${actor.workspaceId},${jobId},${now.toISOString()})`,
      );
      return decode(row);
    });
  }
  async get(ws: string, jobId: string) {
    return this.scoped(ws, async (tx) => {
      const row = (await tx.execute(sql`SELECT * FROM exports WHERE id=${jobId}`)).rows[0];
      return row ? decode(row) : undefined;
    });
  }
  async claim(ws: string, jobId: string, now: Date) {
    return this.scoped(ws, async (tx) => {
      const row = (
        await tx.execute(
          sql`UPDATE exports SET state='running',lease_token=${randomUUID()},lease_until=${new Date(now.getTime() + 120000).toISOString()},attempts=attempts+1,version=version+1 WHERE id=${jobId} AND expires_at>${now.toISOString()} AND state IN ('queued','running') AND (lease_until IS NULL OR lease_until<=${now.toISOString()}) AND NOT EXISTS(SELECT 1 FROM deletion_tombstones d WHERE d.meeting_id=exports.meeting_id) RETURNING *`,
        )
      ).rows[0];
      return row ? decode(row) : undefined;
    });
  }
  async finish(
    job: ExportJob,
    result: {
      state: "complete" | "failed" | "blocked" | "queued";
      content?: string;
      fingerprint?: string;
      errorCode?: string;
    },
    now: Date,
  ) {
    await this.scoped(job.workspaceId, async (tx) => {
      await this.lock(tx, job.workspaceId, job.meetingId);
      const rows = (
        await tx.execute(
          sql`UPDATE exports SET state=${result.state},content=${result.content ?? null},fingerprint=${result.fingerprint ?? null},error_code=${result.errorCode ?? null},lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=${job.id} AND lease_token=${job.leaseToken} AND lease_until>${now.toISOString()} AND state='running' AND expires_at>${now.toISOString()} AND NOT EXISTS(SELECT 1 FROM deletion_tombstones d WHERE d.meeting_id=exports.meeting_id) RETURNING id`,
        )
      ).rows;
      if (!rows.length) return;
      await tx.execute(
        sql`UPDATE export_work_index SET next_at=${(result.state === "queued" ? new Date(now.getTime() + Math.min(300, 2 ** job.attempts) * 1000) : job.expiresAt).toISOString()} WHERE export_id=${job.id}`,
      );
    });
  }
  async remove(
    ws: string,
    deletionId: string,
    input: { meetingId: string; sourceVersion: number },
  ) {
    await this.scoped(ws, async (tx) => {
      await this.lock(tx, ws, input.meetingId);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${ws + ":export-deletion:" + deletionId},0))`,
      );
      const old = (
        await tx.execute(
          sql`SELECT meeting_id,source_version FROM deletion_requests WHERE id=${deletionId}`,
        )
      ).rows[0];
      if (
        old &&
        (old.meeting_id !== input.meetingId || Number(old.source_version) !== input.sourceVersion)
      )
        throw new AppError("DELETION_TARGET_CONFLICT", 409);
      await tx.execute(
        sql`INSERT INTO deletion_requests(workspace_id,id,meeting_id,source_version) VALUES(${ws},${deletionId},${input.meetingId},${input.sourceVersion}) ON CONFLICT DO NOTHING`,
      );
      await tx.execute(
        sql`INSERT INTO deletion_tombstones(workspace_id,meeting_id,source_version) VALUES(${ws},${input.meetingId},${input.sourceVersion}) ON CONFLICT(workspace_id,meeting_id) DO UPDATE SET source_version=GREATEST(deletion_tombstones.source_version,EXCLUDED.source_version)`,
      );
      await tx.execute(
        sql`DELETE FROM export_work_index WHERE workspace_id=${ws} AND export_id IN(SELECT id FROM exports WHERE meeting_id=${input.meetingId})`,
      );
      await tx.execute(
        sql`UPDATE exports SET state='deleted',content=NULL,fingerprint=NULL,error_code=NULL,lease_token=NULL,lease_until=NULL,version=version+1 WHERE meeting_id=${input.meetingId} AND state<>'deleted'`,
      );
    });
  }
  async due() {
    const rows = (
      await this.db.execute(
        sql`SELECT workspace_id,export_id FROM export_work_index WHERE next_at<=now() ORDER BY next_at,export_id LIMIT 25`,
      )
    ).rows;
    return rows.map((row) => ({
      workspaceId: String(row.workspace_id),
      id: String(row.export_id),
    }));
  }
  async expire(now: Date) {
    const due = (
      await this.db.execute(
        sql`SELECT DISTINCT workspace_id FROM export_work_index WHERE next_at<=${now.toISOString()} LIMIT 100`,
      )
    ).rows;
    for (const row of due) await this.expireWorkspace(String(row.workspace_id), now);
  }
  async expireWorkspace(ws: string, now: Date) {
    await this.scoped(ws, async (tx) => {
      await tx.execute(
        sql`UPDATE exports SET state='expired',content=NULL,fingerprint=NULL,lease_token=NULL,lease_until=NULL,version=version+1 WHERE expires_at<=${now.toISOString()} AND state NOT IN('deleted','expired')`,
      );
      await tx.execute(
        sql`DELETE FROM export_work_index WHERE workspace_id=${ws} AND export_id IN(SELECT id FROM exports WHERE state IN('expired','deleted'))`,
      );
    });
  }
}
