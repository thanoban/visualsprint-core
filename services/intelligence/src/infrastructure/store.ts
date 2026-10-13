import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { eventEnvelope, id } from "@visualsprint/contracts";
import { AppError } from "@visualsprint/platform";
import type {
  Job,
  Repository,
  Thread,
  Transaction as RepositoryTransaction,
} from "../application/ports.js";
import type { Evidence, Result, SourceVersion } from "../domain/evidence.js";
import * as schema from "./schema.js";
const makeDb = (pool: pg.Pool) => drizzle(pool, { schema });
type Database = ReturnType<typeof makeDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
class Scoped implements RepositoryTransaction {
  constructor(
    private readonly db: Transaction,
    private readonly workspaceId: string,
  ) {}
  async command<T>(
    actorId: string,
    key: string,
    input: unknown,
    create: () => Promise<T>,
  ): Promise<T> {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.workspaceId + ":" + actorId + ":" + key},0))`,
    );
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const old = (
      await this.db
        .select()
        .from(schema.commands)
        .where(and(eq(schema.commands.actorId, actorId), eq(schema.commands.key, key)))
    )[0];
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      return old.response as T;
    }
    const response = await create();
    await this.db
      .insert(schema.commands)
      .values({ workspaceId: this.workspaceId, actorId, key, fingerprint, response });
    return response;
  }
  async insertThread(thread: Thread) {
    return (await this.db.insert(schema.threads).values(thread).returning())[0]!;
  }
  async thread(threadId: string, ownerId: string) {
    return (
      (
        await this.db
          .select()
          .from(schema.threads)
          .where(and(eq(schema.threads.id, threadId), eq(schema.threads.ownerId, ownerId)))
      )[0] ?? null
    );
  }
  threads(ownerId: string) {
    return this.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.ownerId, ownerId))
      .orderBy(asc(schema.threads.createdAt), asc(schema.threads.id))
      .limit(100);
  }
  async insertJob(job: Job) {
    if (
      job.scope.kind === "meeting" &&
      job.scope.id &&
      (
        await this.db
          .select()
          .from(schema.tombstones)
          .where(eq(schema.tombstones.meetingId, job.scope.id))
      ).length
    )
      throw new AppError("NOT_FOUND", 404);
    const row = (await this.db.insert(schema.jobs).values(job).returning())[0]!;
    await this.db
      .insert(schema.workIndex)
      .values({ workspaceId: this.workspaceId, jobId: row.id, nextAt: new Date() });
    return row;
  }
  async job(jobId: string, ownerId?: string) {
    return (
      (
        await this.db
          .select()
          .from(schema.jobs)
          .where(
            and(eq(schema.jobs.id, jobId), ownerId ? eq(schema.jobs.ownerId, ownerId) : undefined),
          )
      )[0] ?? null
    );
  }
  messages(threadId: string, ownerId: string) {
    return this.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.threadId, threadId), eq(schema.jobs.ownerId, ownerId)))
      .orderBy(asc(schema.jobs.createdAt), asc(schema.jobs.id))
      .limit(100);
  }
  summaries(meetingId: string, ownerId: string) {
    return this.db
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.kind, "summary"),
          eq(schema.jobs.ownerId, ownerId),
          sql`scope->>'kind'='meeting' AND scope->>'id'=${meetingId}`,
        ),
      )
      .orderBy(asc(schema.jobs.createdAt), asc(schema.jobs.id))
      .limit(100);
  }
  async claim(jobId: string) {
    const old = (
      await this.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).for("update")
    )[0];
    if (
      !old ||
      !["queued", "running"].includes(old.status) ||
      (old.leaseUntil && old.leaseUntil > new Date())
    )
      return null;
    if (old.attempts >= 3) {
      await this.db
        .update(schema.jobs)
        .set({
          status: "failed",
          errorCode: "ATTEMPTS_EXHAUSTED",
          leaseToken: null,
          leaseUntil: null,
        })
        .where(eq(schema.jobs.id, jobId));
      await this.db.delete(schema.workIndex).where(eq(schema.workIndex.jobId, jobId));
      return null;
    }
    const leaseToken = randomUUID();
    // Indexed answers have one additional bounded embedding/retrieval phase.
    // Keep its total phase budget within the lease without weakening fencing.
    const leaseUntil = new Date(Date.now() + (old.retrievalMode === "indexed" ? 600_000 : 300_000));
    const row = (
      await this.db
        .update(schema.jobs)
        .set({ status: "running", attempts: old.attempts + 1, leaseToken, leaseUntil })
        .where(eq(schema.jobs.id, jobId))
        .returning()
    )[0]!;
    await this.db
      .update(schema.workIndex)
      .set({ nextAt: leaseUntil })
      .where(eq(schema.workIndex.jobId, jobId));
    return row;
  }
  async complete(jobId: string, token: string, result: Result, evidence: Evidence[]) {
    // Serialize publication with deletion to close the model-in-flight race.
    for (const source of [...result.sourceVersions].sort((a, b) =>
      a.meetingId.localeCompare(b.meetingId),
    ))
      await this.db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.workspaceId + ":delete:" + source.meetingId},0))`,
      );
    const job = (
      await this.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).for("update")
    )[0];
    if (
      !job ||
      job.leaseToken !== token ||
      !job.leaseUntil ||
      job.leaseUntil < new Date() ||
      job.status !== "running"
    )
      return false;
    const ids = result.sourceVersions.map((row) => row.meetingId);
    if (
      ids.length &&
      (
        await this.db
          .select()
          .from(schema.tombstones)
          .where(inArray(schema.tombstones.meetingId, ids))
      ).length
    )
      throw new AppError("SOURCE_DELETED", 409);
    if (ids.length)
      await this.db
        .delete(schema.evidence)
        .where(
          and(eq(schema.evidence.ownerId, job.ownerId), inArray(schema.evidence.meetingId, ids)),
        );
    for (let start = 0; start < evidence.length; start += 100) {
      const rows = evidence
        .slice(start, start + 100)
        .map((row) => ({ ...row, workspaceId: this.workspaceId, ownerId: job.ownerId }));
      if (rows.length)
        await this.db
          .insert(schema.evidence)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              schema.evidence.workspaceId,
              schema.evidence.ownerId,
              schema.evidence.meetingId,
              schema.evidence.captureId,
              schema.evidence.segmentId,
            ],
            set: {
              revision: sql`excluded.revision`,
              text: sql`excluded.text`,
              startMs: sql`excluded.start_ms`,
              endMs: sql`excluded.end_ms`,
              speakerLabel: sql`excluded.speaker_label`,
            },
          });
    }
    await this.db
      .update(schema.jobs)
      .set({ status: "complete", result, errorCode: null, leaseToken: null, leaseUntil: null })
      .where(eq(schema.jobs.id, jobId));
    await this.db.delete(schema.workIndex).where(eq(schema.workIndex.jobId, jobId));
    if (job.kind === "summary")
      await this.db.insert(schema.outbox).values({
        workspaceId: this.workspaceId,
        id: randomUUID(),
        event: eventEnvelope.parse({
          eventId: randomUUID(),
          type: "summary.ready.v1",
          schemaVersion: 1,
          workspaceId: this.workspaceId,
          aggregateId: job.id,
          aggregateVersion: 1,
          occurredAt: new Date().toISOString(),
          traceId: randomUUID().replaceAll("-", ""),
          actorId: job.ownerId,
          references: result.sourceVersions
            .slice(0, 20)
            .map((row) => ({ kind: "meeting", id: row.meetingId, revision: row.version })),
        }),
      });
    return true;
  }
  async pinSources(jobId: string, token: string, versions: SourceVersion[]) {
    for (const source of [...versions].sort((a, b) => a.meetingId.localeCompare(b.meetingId)))
      await this.db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.workspaceId + ":delete:" + source.meetingId},0))`,
      );
    const ids = versions.map((row) => row.meetingId);
    if (
      ids.length &&
      (
        await this.db
          .select()
          .from(schema.tombstones)
          .where(inArray(schema.tombstones.meetingId, ids))
      ).length
    )
      throw new AppError("SOURCE_DELETED", 409);
    const rows = await this.db
      .update(schema.jobs)
      .set({ sourceVersions: versions })
      .where(
        and(
          eq(schema.jobs.id, jobId),
          eq(schema.jobs.leaseToken, token),
          eq(schema.jobs.status, "running"),
          sql`${schema.jobs.leaseUntil}>now()+interval '120 seconds'`,
        ),
      )
      .returning();
    return rows.length === 1;
  }
  async fail(jobId: string, token: string, code: string, retry: boolean) {
    const rows = await this.db
      .update(schema.jobs)
      .set({
        status: retry ? "queued" : "failed",
        errorCode: code,
        leaseToken: null,
        leaseUntil: null,
      })
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.leaseToken, token)))
      .returning();
    if (!rows.length) return;
    if (retry)
      await this.db
        .update(schema.workIndex)
        .set({ nextAt: new Date(Date.now() + 30_000) })
        .where(eq(schema.workIndex.jobId, jobId));
    else await this.db.delete(schema.workIndex).where(eq(schema.workIndex.jobId, jobId));
  }
  async invalidate(jobId: string) {
    await this.db
      .update(schema.jobs)
      .set({ status: "invalidated", result: null, errorCode: "SOURCE_CHANGED" })
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, "complete")));
  }
  async purgeMeeting(meetingId: string, deletionId: string, sourceVersion: number) {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.workspaceId + ":delete:" + meetingId},0))`,
    );
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.workspaceId + ":deletion-id:" + deletionId},0))`,
    );
    const existing = (
      await this.db
        .select()
        .from(schema.tombstones)
        .where(eq(schema.tombstones.deletionId, deletionId))
    )[0];
    if (existing && (existing.meetingId !== meetingId || existing.sourceVersion !== sourceVersion))
      throw new AppError("IDEMPOTENCY_CONFLICT", 409);
    const old = (
      await this.db
        .select()
        .from(schema.tombstones)
        .where(eq(schema.tombstones.meetingId, meetingId))
    )[0];
    if (old && (old.deletionId !== deletionId || old.sourceVersion !== sourceVersion))
      throw new AppError("DELETION_CONFLICT", 409);
    await this.db
      .insert(schema.tombstones)
      .values({ workspaceId: this.workspaceId, meetingId, deletionId, sourceVersion })
      .onConflictDoNothing();
    const rows = await this.db.execute<{ id: string }>(
      sql`SELECT id FROM intelligence_jobs WHERE (scope->>'kind'='meeting' AND scope->>'id'=${meetingId}) OR source_versions @> ${JSON.stringify([{ meetingId }])}::jsonb OR result->'sourceVersions' @> ${JSON.stringify([{ meetingId }])}::jsonb`,
    );
    const ids = rows.rows.map((row) => row.id);
    if (ids.length) {
      await this.db.delete(schema.commands).where(
        sql`response->>'id' IN (${sql.join(
          ids.map((value) => sql`${value}`),
          sql`,`,
        )})`,
      );
      await this.db.delete(schema.jobs).where(inArray(schema.jobs.id, ids));
    }
    const threads = await this.db
      .select()
      .from(schema.threads)
      .where(sql`scope->>'kind'='meeting' AND scope->>'id'=${meetingId}`);
    if (threads.length) {
      const ids = threads.map((row) => row.id);
      await this.db.delete(schema.commands).where(
        sql`response->>'id' IN (${sql.join(
          ids.map((value) => sql`${value}`),
          sql`,`,
        )})`,
      );
      await this.db.delete(schema.threads).where(inArray(schema.threads.id, ids));
    }
    await this.db.delete(schema.evidence).where(eq(schema.evidence.meetingId, meetingId));
    // Event metadata still identifies deleted sources; remove it rather than
    // relying on a later projection to reinterpret deleted content.
    await this.db
      .delete(schema.outbox)
      .where(
        sql`event->'references' @> ${JSON.stringify([{ kind: "meeting", id: meetingId }])}::jsonb`,
      );
  }
}
export class PostgresIntelligence implements Repository {
  private readonly db: Database;
  constructor(pool: pg.Pool) {
    this.db = makeDb(pool);
  }
  scoped<T>(workspaceId: string, work: (tx: RepositoryTransaction) => Promise<T>) {
    id.parse(workspaceId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id',${workspaceId},true)`);
      return work(new Scoped(tx, workspaceId));
    });
  }
  async due() {
    return await this.db
      .select({ workspaceId: schema.workIndex.workspaceId, id: schema.workIndex.jobId })
      .from(schema.workIndex)
      .where(lte(schema.workIndex.nextAt, new Date()))
      .orderBy(asc(schema.workIndex.nextAt))
      .limit(20);
  }
}
