import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { IndexJob, VectorIndexes } from "../application/index-ports.js";
import type { Scope, SourceVersion } from "../domain/evidence.js";
import { validateEmbedding, type EmbeddedChunk, type EvidenceChunk } from "../domain/indexing.js";
import { tombstones } from "./schema.js";
import * as schema from "./vector-schema.js";
const makeDb = (pool: pg.Pool) => drizzle(pool, { schema });
type Database = ReturnType<typeof makeDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export class PostgresVectorIndexes implements VectorIndexes {
  private readonly db: Database;
  constructor(pool: pg.Pool) {
    this.db = makeDb(pool);
  }
  private scoped<T>(workspaceId: string, work: (tx: Transaction) => Promise<T>) {
    id.parse(workspaceId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id',${workspaceId},true)`);
      return work(tx);
    });
  }
  private async lockSources(tx: Transaction, workspaceId: string, versions: SourceVersion[]) {
    const ids = [...new Set(versions.map((row) => row.meetingId))].sort();
    for (const meetingId of ids)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ":delete:" + meetingId},0))`,
      );
    if (
      ids.length &&
      (await tx.select().from(tombstones).where(inArray(tombstones.meetingId, ids))).length
    )
      throw new AppError("SOURCE_DELETED", 409);
  }
  load(actor: Actor, jobId: string) {
    return this.scoped(
      actor.workspaceId,
      async (tx) =>
        (
          await tx
            .select()
            .from(schema.indexJobs)
            .where(
              and(
                eq(schema.indexJobs.id, id.parse(jobId)),
                eq(schema.indexJobs.ownerId, actor.actorId),
              ),
            )
        )[0] ?? null,
    );
  }
  create(actor: Actor, key: string, input: Parameters<VectorIndexes["create"]>[2]) {
    return this.scoped(actor.workspaceId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.workspaceId + ":index-command:" + actor.actorId + ":" + key},0))`,
      );
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ kind: input.scope.kind, id: input.scope.id }))
        .digest("hex");
      const old = (
        await tx
          .select()
          .from(schema.indexCommands)
          .where(
            and(eq(schema.indexCommands.ownerId, actor.actorId), eq(schema.indexCommands.key, key)),
          )
      )[0];
      if (old) {
        if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        return (
          await tx
            .select()
            .from(schema.indexJobs)
            .where(
              and(eq(schema.indexJobs.id, old.jobId), eq(schema.indexJobs.ownerId, actor.actorId)),
            )
        )[0]!;
      }
      await this.lockSources(tx, actor.workspaceId, input.sourceVersions);
      const job: IndexJob = {
        workspaceId: actor.workspaceId,
        id: randomUUID(),
        ownerId: actor.actorId,
        sessionId: actor.sessionId,
        ...input,
        status: "queued",
        cursor: 0,
        attempts: 0,
        failures: 0,
        leaseToken: null,
        leaseUntil: null,
        errorCode: null,
        createdAt: new Date(),
      };
      await tx.insert(schema.indexJobs).values(job);
      await tx.insert(schema.indexCommands).values({
        workspaceId: actor.workspaceId,
        ownerId: actor.actorId,
        key,
        fingerprint,
        jobId: job.id,
      });
      await tx
        .insert(schema.vectorWork)
        .values({ workspaceId: actor.workspaceId, jobId: job.id, nextAt: new Date() });
      return job;
    });
  }
  claim(workspaceId: string, jobId: string) {
    return this.scoped(workspaceId, async (tx) => {
      const job = (
        await tx
          .select()
          .from(schema.indexJobs)
          .where(eq(schema.indexJobs.id, id.parse(jobId)))
          .for("update")
      )[0];
      if (
        !job ||
        !["queued", "running"].includes(job.status) ||
        (job.leaseUntil && job.leaseUntil > new Date())
      )
        return null;
      const failures = job.failures + (job.status === "running" ? 1 : 0);
      if (failures >= 3) {
        await tx
          .update(schema.indexJobs)
          .set({
            status: "failed",
            errorCode: "ATTEMPTS_EXHAUSTED",
            leaseToken: null,
            leaseUntil: null,
            failures,
          })
          .where(eq(schema.indexJobs.id, jobId));
        await tx.delete(schema.embeddings).where(eq(schema.embeddings.indexId, jobId));
        await tx.delete(schema.vectorWork).where(eq(schema.vectorWork.jobId, jobId));
        return null;
      }
      const leaseUntil = new Date(Date.now() + 300_000);
      const row = (
        await tx
          .update(schema.indexJobs)
          .set({
            status: "running",
            leaseToken: randomUUID(),
            leaseUntil,
            attempts: job.attempts + 1,
            failures,
          })
          .where(eq(schema.indexJobs.id, jobId))
          .returning()
      )[0]!;
      await tx
        .update(schema.vectorWork)
        .set({ nextAt: leaseUntil })
        .where(eq(schema.vectorWork.jobId, jobId));
      return row;
    });
  }
  stage(job: IndexJob, chunks: EmbeddedChunk[], finished: boolean) {
    return this.scoped(job.workspaceId, async (tx) => {
      if (chunks.length > 16 || (!finished && !chunks.length))
        throw new AppError("INVALID_INDEX_BATCH", 400);
      await this.lockSources(tx, job.workspaceId, job.sourceVersions);
      const current = (
        await tx
          .select()
          .from(schema.indexJobs)
          .where(eq(schema.indexJobs.id, job.id))
          .for("update")
      )[0];
      if (
        !current ||
        current.status !== "running" ||
        current.leaseToken !== job.leaseToken ||
        !current.leaseUntil ||
        current.leaseUntil < new Date() ||
        current.cursor !== job.cursor ||
        current.sourceFingerprint !== job.sourceFingerprint
      )
        return false;
      const next = job.cursor + chunks.length;
      if (next > job.totalChunks || finished !== (next === job.totalChunks))
        throw new AppError("INVALID_INDEX_BATCH", 400);
      const allowed = new Map(job.sourceVersions.map((row) => [row.meetingId, row.captureId]));
      if (chunks.some((row) => allowed.get(row.meetingId) !== row.captureId))
        throw new AppError("INDEX_SOURCE_MISMATCH", 409);
      if (chunks.length)
        await tx.insert(schema.embeddings).values(
          chunks.map((row, index) => ({
            ...row,
            workspaceId: job.workspaceId,
            indexId: job.id,
            ownerId: job.ownerId,
            ordinal: job.cursor + index,
          })),
        );
      await tx
        .update(schema.indexJobs)
        .set({
          status: finished ? "complete" : "queued",
          cursor: next,
          failures: 0,
          errorCode: null,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(eq(schema.indexJobs.id, job.id));
      if (finished) {
        await tx.delete(schema.vectorWork).where(eq(schema.vectorWork.jobId, job.id));
        const old = await tx
          .update(schema.indexJobs)
          .set({ status: "failed", errorCode: "INDEX_SUPERSEDED" })
          .where(
            and(
              eq(schema.indexJobs.ownerId, job.ownerId),
              ne(schema.indexJobs.id, job.id),
              eq(schema.indexJobs.status, "complete"),
              eq(schema.indexJobs.scope, job.scope),
              eq(schema.indexJobs.sourceFingerprint, job.sourceFingerprint),
            ),
          )
          .returning({ id: schema.indexJobs.id });
        if (old.length)
          await tx.delete(schema.embeddings).where(
            inArray(
              schema.embeddings.indexId,
              old.map((row) => row.id),
            ),
          );
      } else
        await tx
          .update(schema.vectorWork)
          .set({ nextAt: new Date(Date.now() + 1000) })
          .where(eq(schema.vectorWork.jobId, job.id));
      return true;
    });
  }
  fail(job: IndexJob, code: string, transient: boolean) {
    return this.scoped(job.workspaceId, async (tx) => {
      const current = (
        await tx
          .select()
          .from(schema.indexJobs)
          .where(eq(schema.indexJobs.id, job.id))
          .for("update")
      )[0];
      if (!current || current.leaseToken !== job.leaseToken) return;
      const failures = current.failures + 1,
        retry = transient && failures < 3;
      await tx
        .update(schema.indexJobs)
        .set({
          status: retry ? "queued" : "failed",
          errorCode: code,
          failures,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(eq(schema.indexJobs.id, job.id));
      if (retry)
        await tx
          .update(schema.vectorWork)
          .set({ nextAt: new Date(Date.now() + 30_000) })
          .where(eq(schema.vectorWork.jobId, job.id));
      else {
        await tx.delete(schema.embeddings).where(eq(schema.embeddings.indexId, job.id));
        await tx.delete(schema.vectorWork).where(eq(schema.vectorWork.jobId, job.id));
      }
    });
  }
  latest(actor: Actor, scope: Scope, sourceFingerprint: string) {
    return this.scoped(
      actor.workspaceId,
      async (tx) =>
        (
          await tx
            .select()
            .from(schema.indexJobs)
            .where(
              and(
                eq(schema.indexJobs.ownerId, actor.actorId),
                eq(schema.indexJobs.scope, scope),
                eq(schema.indexJobs.sourceFingerprint, sourceFingerprint),
                eq(schema.indexJobs.status, "complete"),
              ),
            )
            .orderBy(desc(schema.indexJobs.createdAt), desc(schema.indexJobs.id))
            .limit(1)
        )[0] ?? null,
    );
  }
  search(actor: Actor, jobId: string, meetingIds: string[], queryVector: number[], query: string) {
    validateEmbedding(queryVector);
    meetingIds.forEach((value) => id.parse(value));
    if (meetingIds.length > 100) throw new AppError("SCOPE_TOO_LARGE", 409);
    return this.scoped(actor.workspaceId, async (tx) => {
      const job = (
        await tx
          .select()
          .from(schema.indexJobs)
          .where(
            and(
              eq(schema.indexJobs.id, id.parse(jobId)),
              eq(schema.indexJobs.ownerId, actor.actorId),
              eq(schema.indexJobs.status, "complete"),
            ),
          )
      )[0];
      if (!job) throw new AppError("INDEX_NOT_READY", 409);
      if (!meetingIds.length) return [];
      const result = await tx.execute<EvidenceChunk>(sql`
        WITH allowed AS MATERIALIZED (
          SELECT ordinal,meeting_id AS "meetingId",capture_id AS "captureId",segment_id AS "segmentId",revision,chunk_index AS "chunkIndex",character_start AS "characterStart",character_end AS "characterEnd",start_ms AS "startMs",end_ms AS "endMs",text,speaker_label AS "speakerLabel",embedding,document
          FROM evidence_embeddings WHERE index_id=${jobId}::uuid AND owner_id=${actor.actorId}::uuid AND meeting_id IN (${sql.join(
            meetingIds.map((value) => sql`${value}::uuid`),
            sql`,`,
          )})
        ), semantic AS (
          SELECT ordinal,row_number() OVER(ORDER BY embedding <=> ${JSON.stringify(queryVector)}::vector,ordinal) AS rank FROM allowed ORDER BY embedding <=> ${JSON.stringify(queryVector)}::vector,ordinal LIMIT 100
        ), lexical AS (
          SELECT ordinal,row_number() OVER(ORDER BY ts_rank_cd(document,plainto_tsquery('english',${query})) DESC,ordinal) AS rank FROM allowed WHERE document @@ plainto_tsquery('english',${query}) ORDER BY ts_rank_cd(document,plainto_tsquery('english',${query})) DESC,ordinal LIMIT 100
        ), ranking AS (
          SELECT coalesce(s.ordinal,l.ordinal) AS ordinal,coalesce(1.0/(60+s.rank),0)+coalesce(1.0/(60+l.rank),0) AS score FROM semantic s FULL JOIN lexical l USING(ordinal)
        ) SELECT a."meetingId",a."captureId",a."segmentId",a.revision,a."chunkIndex",a."characterStart",a."characterEnd",a."startMs",a."endMs",a.text,a."speakerLabel" FROM allowed a JOIN ranking r USING(ordinal) ORDER BY r.score DESC,a.ordinal LIMIT 100`);
      return result.rows;
    });
  }
  purgeMeeting(workspaceId: string, meetingId: string) {
    return this.scoped(workspaceId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ":delete:" + id.parse(meetingId)},0))`,
      );
      if (!(await tx.select().from(tombstones).where(eq(tombstones.meetingId, meetingId))).length)
        throw new AppError("DELETION_BARRIER_REQUIRED", 409);
      const affected = await tx
        .select({ id: schema.indexJobs.id })
        .from(schema.indexJobs)
        .where(sql`source_versions @> ${JSON.stringify([{ meetingId }])}::jsonb`);
      if (affected.length)
        await tx.delete(schema.indexJobs).where(
          inArray(
            schema.indexJobs.id,
            affected.map((row) => row.id),
          ),
        );
    });
  }
  due() {
    return this.db
      .select({ workspaceId: schema.vectorWork.workspaceId, id: schema.vectorWork.jobId })
      .from(schema.vectorWork)
      .where(lte(schema.vectorWork.nextAt, new Date()))
      .orderBy(asc(schema.vectorWork.nextAt), asc(schema.vectorWork.jobId))
      .limit(20);
  }
}
