import { randomUUID, randomBytes, createHash } from "node:crypto";
import { eventEnvelope } from "@visualsprint/contracts";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { AppError, type Actor } from "@visualsprint/platform";
import type {
  DeletionJob,
  DeletionParticipant,
  DeletionRepository,
} from "../application/deletion-service.js";
const dbFor = (pool: pg.Pool) => drizzle(pool);
type Tx = Parameters<Parameters<ReturnType<typeof dbFor>["transaction"]>[0]>[0];
const decode = (row: Record<string, unknown>): DeletionJob => ({
  workspaceId: String(row.workspace_id),
  id: String(row.id),
  meetingId: String(row.meeting_id),
  ownerId: String(row.owner_id),
  sessionId: String(row.session_id),
  sourceVersion: Number(row.source_version),
  state: row.state as DeletionJob["state"],
  required: row.required as DeletionParticipant[],
  acknowledgements: row.acknowledgements as DeletionJob["acknowledgements"],
  leaseToken: row.lease_token as string | null,
});
export class PostgresDeletions implements DeletionRepository {
  private readonly db;
  constructor(pool: pg.Pool) {
    this.db = dbFor(pool);
  }
  private scoped<T>(ws: string, work: (tx: Tx) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id',${ws},true)`);
      return work(tx);
    });
  }
  async request(
    actor: Actor,
    key: string,
    input: { meetingId: string; expectedVersion: number },
    required: DeletionParticipant[],
  ) {
    return this.scoped(actor.workspaceId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.workspaceId + ":delete-command:" + actor.actorId + ":" + key},0))`,
      );
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const old = (
        await tx.execute(
          sql`SELECT fingerprint,deletion_id FROM deletion_commands WHERE owner_id=${actor.actorId} AND key=${key}`,
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        return decode(
          (await tx.execute(sql`SELECT * FROM deletion_jobs WHERE id=${old.deletion_id}`)).rows[0]!,
        );
      }
      const meeting = (
        await tx.execute(
          sql`SELECT owner_id,version,blocked FROM meetings WHERE id=${input.meetingId} FOR UPDATE`,
        )
      ).rows[0];
      if (!meeting || meeting.owner_id !== actor.actorId) throw new AppError("NOT_FOUND", 404);
      const existing = (
        await tx.execute(sql`SELECT * FROM deletion_jobs WHERE meeting_id=${input.meetingId}`)
      ).rows[0];
      if (existing) {
        const result = decode(existing);
        await tx.execute(
          sql`INSERT INTO deletion_commands(workspace_id,owner_id,key,fingerprint,deletion_id) VALUES(${actor.workspaceId},${actor.actorId},${key},${fingerprint},${result.id})`,
        );
        return result;
      }
      if (meeting.blocked) throw new AppError("NOT_FOUND", 404);
      if (Number(meeting.version) !== input.expectedVersion)
        throw new AppError("VERSION_CONFLICT", 409);
      const deletionId = randomUUID(),
        sourceVersion = input.expectedVersion + 1;
      await tx.execute(
        sql`UPDATE meetings SET blocked=true,title='Deleted meeting',notes='',join_url=NULL,version=${sourceVersion} WHERE id=${input.meetingId}`,
      );
      await tx.execute(sql`DELETE FROM meeting_readers WHERE meeting_id=${input.meetingId}`);
      await tx.execute(sql`DELETE FROM meeting_assignments WHERE meeting_id=${input.meetingId}`);
      await tx.execute(sql`DELETE FROM accepted_items WHERE meeting_id=${input.meetingId}`);
      await tx.execute(
        sql`UPDATE calendar_meetings SET last_title='',fingerprint='deleted',starts_at=NULL,ends_at=NULL WHERE meeting_id=${input.meetingId}`,
      );
      await tx.execute(
        sql`UPDATE commands SET response=jsonb_build_object('id',${input.meetingId}::text,'deleted',true) WHERE response->>'id'=${input.meetingId} OR response->>'meetingId'=${input.meetingId}`,
      );
      const job = (
        await tx.execute(
          sql`INSERT INTO deletion_jobs(workspace_id,id,meeting_id,owner_id,session_id,source_version,state,required) VALUES(${actor.workspaceId},${deletionId},${input.meetingId},${actor.actorId},${actor.sessionId},${sourceVersion},'pending',${JSON.stringify(required)}::jsonb) RETURNING *`,
        )
      ).rows[0]!;
      await tx.execute(
        sql`INSERT INTO deletion_commands(workspace_id,owner_id,key,fingerprint,deletion_id) VALUES(${actor.workspaceId},${actor.actorId},${key},${fingerprint},${deletionId})`,
      );
      await tx.execute(
        sql`INSERT INTO deletion_work_index(workspace_id,deletion_id) VALUES(${actor.workspaceId},${deletionId})`,
      );
      const event = eventEnvelope.parse({
        eventId: randomUUID(),
        type: "deletion.requested.v1",
        schemaVersion: 1,
        workspaceId: actor.workspaceId,
        aggregateId: deletionId,
        aggregateVersion: 1,
        occurredAt: new Date().toISOString(),
        traceId: randomBytes(16).toString("hex"),
        actorId: actor.actorId,
        references: [
          { kind: "meeting", id: input.meetingId, revision: sourceVersion },
          { kind: "deletion", id: deletionId },
        ],
      });
      await tx.execute(
        sql`INSERT INTO outbox(workspace_id,id,event) VALUES(${actor.workspaceId},${event.eventId},${JSON.stringify(event)}::jsonb)`,
      );
      await tx.execute(
        sql`INSERT INTO event_work_index(workspace_id,next_at) VALUES(${actor.workspaceId},now()) ON CONFLICT(workspace_id) DO UPDATE SET next_at=LEAST(event_work_index.next_at,excluded.next_at)`,
      );
      return decode(job);
    });
  }
  async get(ws: string, jobId: string) {
    return this.scoped(ws, async (tx) => {
      const row = (await tx.execute(sql`SELECT * FROM deletion_jobs WHERE id=${jobId}`)).rows[0];
      return row ? decode(row) : undefined;
    });
  }
  async existing(ws: string, meetingId: string) {
    return this.scoped(ws, async (tx) => {
      const row = (await tx.execute(sql`SELECT * FROM deletion_jobs WHERE meeting_id=${meetingId}`))
        .rows[0];
      return row ? decode(row) : undefined;
    });
  }
  async claim(ws: string, jobId: string) {
    return this.scoped(ws, async (tx) => {
      const row = (
        await tx.execute(
          sql`UPDATE deletion_jobs SET lease_token=${randomUUID()},lease_until=now()+interval '120 seconds' WHERE id=${jobId} AND state='pending' AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,
        )
      ).rows[0];
      return row ? decode(row) : undefined;
    });
  }
  async ack(job: DeletionJob, participant: DeletionParticipant) {
    await this.scoped(job.workspaceId, async (tx) => {
      await tx.execute(
        sql`UPDATE deletion_jobs SET acknowledgements=acknowledgements||${JSON.stringify({ [participant]: "complete" })}::jsonb WHERE id=${job.id} AND lease_token=${job.leaseToken} AND required ? ${participant}`,
      );
    });
  }
  async release(job: DeletionJob) {
    await this.scoped(job.workspaceId, async (tx) => {
      const row = (
        await tx.execute(
          sql`UPDATE deletion_jobs SET state=CASE WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(required) AS p(name) WHERE acknowledgements->>p.name<>'complete' OR acknowledgements->>p.name IS NULL) THEN 'complete' ELSE 'pending' END,lease_token=NULL,lease_until=NULL WHERE id=${job.id} AND lease_token=${job.leaseToken} RETURNING state`,
        )
      ).rows[0];
      if (!row) return;
      if (row.state === "complete")
        await tx.execute(sql`DELETE FROM deletion_work_index WHERE deletion_id=${job.id}`);
      else
        await tx.execute(
          sql`UPDATE deletion_work_index SET next_at=now()+interval '30 seconds' WHERE deletion_id=${job.id}`,
        );
    });
  }
  async due() {
    return (
      await this.db.execute(
        sql`SELECT workspace_id,deletion_id FROM deletion_work_index WHERE next_at<=now() ORDER BY next_at LIMIT 25`,
      )
    ).rows.map((r) => ({ workspaceId: String(r.workspace_id), id: String(r.deletion_id) }));
  }
}
