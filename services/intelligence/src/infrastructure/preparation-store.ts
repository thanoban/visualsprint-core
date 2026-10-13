import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type {
  PreparationJob,
  PreparationJobs,
  PreparationInput,
} from "../application/preparation-jobs.js";
import type { PreparationDraft } from "../domain/preparation.js";
import type { SourceVersion } from "../domain/evidence.js";
import { tombstones } from "./schema.js";
import * as schema from "./preparation-schema.js";
const makeDb = (pool: pg.Pool) => drizzle(pool, { schema });
type Database = ReturnType<typeof makeDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export class PostgresPreparation implements PreparationJobs {
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
  private async sources(
    tx: Transaction,
    workspaceId: string,
    meetingId: string,
    versions: SourceVersion[],
  ) {
    const ids = [...new Set([meetingId, ...versions.map((row) => row.meetingId)])].sort();
    for (const value of ids)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ":delete:" + value},0))`,
      );
    if ((await tx.select().from(tombstones).where(inArray(tombstones.meetingId, ids))).length)
      throw new AppError("SOURCE_DELETED", 409);
  }
  create(actor: Actor, key: string, input: PreparationInput, sourceVersions: SourceVersion[]) {
    return this.scoped(actor.workspaceId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.workspaceId + ":preparation-command:" + actor.actorId + ":" + key},0))`,
      );
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const old = (
        await tx
          .select()
          .from(schema.preparationCommands)
          .where(
            and(
              eq(schema.preparationCommands.ownerId, actor.actorId),
              eq(schema.preparationCommands.key, key),
            ),
          )
      )[0];
      if (old) {
        if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        return (
          await tx
            .select()
            .from(schema.preparationJobs)
            .where(
              and(
                eq(schema.preparationJobs.id, old.jobId),
                eq(schema.preparationJobs.ownerId, actor.actorId),
              ),
            )
        )[0]!;
      }
      await this.sources(tx, actor.workspaceId, input.meetingId, sourceVersions);
      const job: PreparationJob = {
        workspaceId: actor.workspaceId,
        id: randomUUID(),
        ownerId: actor.actorId,
        sessionId: actor.sessionId,
        input,
        sourceVersions,
        status: "queued",
        attempts: 0,
        result: null,
        commitmentsFingerprint: null,
        errorCode: null,
        leaseToken: null,
        leaseUntil: null,
        createdAt: new Date(),
      };
      await tx.insert(schema.preparationJobs).values(job);
      await tx.insert(schema.preparationCommands).values({
        workspaceId: actor.workspaceId,
        ownerId: actor.actorId,
        key,
        fingerprint,
        jobId: job.id,
      });
      await tx
        .insert(schema.preparationWork)
        .values({ workspaceId: actor.workspaceId, jobId: job.id, nextAt: new Date() });
      return job;
    });
  }
  load(actor: Actor, jobId: string) {
    return this.scoped(
      actor.workspaceId,
      async (tx) =>
        (
          await tx
            .select()
            .from(schema.preparationJobs)
            .where(
              and(
                eq(schema.preparationJobs.id, jobId),
                eq(schema.preparationJobs.ownerId, actor.actorId),
              ),
            )
        )[0] ?? null,
    );
  }
  claim(workspaceId: string, jobId: string) {
    return this.scoped(workspaceId, async (tx) => {
      const old = (
        await tx
          .select()
          .from(schema.preparationJobs)
          .where(eq(schema.preparationJobs.id, jobId))
          .for("update")
      )[0];
      if (
        !old ||
        !["queued", "running"].includes(old.status) ||
        (old.leaseUntil && old.leaseUntil > new Date())
      )
        return null;
      if (old.attempts >= 3) {
        await tx
          .update(schema.preparationJobs)
          .set({
            status: "failed",
            errorCode: "ATTEMPTS_EXHAUSTED",
            leaseToken: null,
            leaseUntil: null,
          })
          .where(eq(schema.preparationJobs.id, jobId));
        await tx.delete(schema.preparationWork).where(eq(schema.preparationWork.jobId, jobId));
        return null;
      }
      const leaseUntil = new Date(Date.now() + 300_000);
      const job = (
        await tx
          .update(schema.preparationJobs)
          .set({
            status: "running",
            attempts: old.attempts + 1,
            leaseToken: randomUUID(),
            leaseUntil,
          })
          .where(eq(schema.preparationJobs.id, jobId))
          .returning()
      )[0]!;
      await tx
        .update(schema.preparationWork)
        .set({ nextAt: leaseUntil })
        .where(eq(schema.preparationWork.jobId, jobId));
      return job;
    });
  }
  pin(job: PreparationJob, sourceVersions: SourceVersion[]) {
    return this.scoped(job.workspaceId, async (tx) => {
      await this.sources(tx, job.workspaceId, job.input.meetingId, sourceVersions);
      const rows = await tx
        .update(schema.preparationJobs)
        .set({ sourceVersions })
        .where(
          and(
            eq(schema.preparationJobs.id, job.id),
            eq(schema.preparationJobs.leaseToken, job.leaseToken!),
            eq(schema.preparationJobs.status, "running"),
            sql`${schema.preparationJobs.leaseUntil}>now()+interval '120 seconds'`,
          ),
        )
        .returning();
      return rows.length === 1;
    });
  }
  complete(job: PreparationJob, draft: PreparationDraft, commitmentsFingerprint: string) {
    return this.scoped(job.workspaceId, async (tx) => {
      await this.sources(tx, job.workspaceId, job.input.meetingId, draft.sourceVersions);
      const current = (
        await tx
          .select()
          .from(schema.preparationJobs)
          .where(eq(schema.preparationJobs.id, job.id))
          .for("update")
      )[0];
      if (
        !current ||
        current.status !== "running" ||
        current.leaseToken !== job.leaseToken ||
        !current.leaseUntil ||
        current.leaseUntil < new Date()
      )
        return false;
      if (
        draft.meetingId !== job.input.meetingId ||
        draft.historyScope.kind !== job.input.historyScope.kind ||
        draft.historyScope.id !== job.input.historyScope.id ||
        !draft.reviewRequired
      )
        throw new AppError("PREPARATION_SCOPE_MISMATCH", 409);
      await tx
        .update(schema.preparationJobs)
        .set({
          status: "complete",
          result: draft,
          commitmentsFingerprint,
          sourceVersions: draft.sourceVersions,
          errorCode: null,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(eq(schema.preparationJobs.id, job.id));
      await tx.delete(schema.preparationWork).where(eq(schema.preparationWork.jobId, job.id));
      return true;
    });
  }
  fail(job: PreparationJob, code: string, transient: boolean) {
    return this.scoped(job.workspaceId, async (tx) => {
      const retry = transient && job.attempts < 3;
      const rows = await tx
        .update(schema.preparationJobs)
        .set({
          status: retry ? "queued" : "failed",
          errorCode: code,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(
          and(
            eq(schema.preparationJobs.id, job.id),
            eq(schema.preparationJobs.leaseToken, job.leaseToken!),
          ),
        )
        .returning();
      if (!rows.length) return;
      if (retry)
        await tx
          .update(schema.preparationWork)
          .set({ nextAt: new Date(Date.now() + 30_000) })
          .where(eq(schema.preparationWork.jobId, job.id));
      else await tx.delete(schema.preparationWork).where(eq(schema.preparationWork.jobId, job.id));
    });
  }
  invalidate(actor: Actor, jobId: string) {
    return this.scoped(actor.workspaceId, async (tx) => {
      await tx
        .update(schema.preparationJobs)
        .set({ status: "invalidated", result: null, errorCode: "SOURCE_CHANGED" })
        .where(
          and(
            eq(schema.preparationJobs.id, jobId),
            eq(schema.preparationJobs.ownerId, actor.actorId),
            eq(schema.preparationJobs.status, "complete"),
          ),
        );
    });
  }
  purgeMeeting(workspaceId: string, meetingId: string) {
    return this.scoped(workspaceId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ":delete:" + id.parse(meetingId)},0))`,
      );
      if (!(await tx.select().from(tombstones).where(eq(tombstones.meetingId, meetingId))).length)
        throw new AppError("DELETION_BARRIER_REQUIRED", 409);
      await tx
        .delete(schema.preparationJobs)
        .where(
          sql`input->>'meetingId'=${meetingId} OR source_versions @> ${JSON.stringify([{ meetingId }])}::jsonb`,
        );
    });
  }
  due() {
    return this.db
      .select({ workspaceId: schema.preparationWork.workspaceId, id: schema.preparationWork.jobId })
      .from(schema.preparationWork)
      .where(lte(schema.preparationWork.nextAt, new Date()))
      .orderBy(asc(schema.preparationWork.nextAt), asc(schema.preparationWork.jobId))
      .limit(20);
  }
}
