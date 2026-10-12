import { randomUUID, randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { AppError, type Actor } from "@visualsprint/platform";
import { eventEnvelope, id, type DomainEvent } from "@visualsprint/contracts";
import type {
  CaptureRepository,
  CaptureTransaction,
  CaptureContext,
  Capture,
  Segment,
} from "../application/ports.js";
import * as schema from "./schema.js";

const database = (pool: pg.Pool) => drizzle(pool, { schema });
type Database = ReturnType<typeof database>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
class CaptureTx implements CaptureTransaction {
  constructor(
    private readonly db: Transaction,
    private readonly workspaceId: string,
  ) {}
  async load(requestId: string) {
    return (
      await this.db
        .select()
        .from(schema.requests)
        .where(
          and(
            eq(schema.requests.workspaceId, this.workspaceId),
            eq(schema.requests.id, id.parse(requestId)),
          ),
        )
        .for("update")
    )[0];
  }
  list(meetingId: string) {
    return this.db
      .select()
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.workspaceId, this.workspaceId),
          eq(schema.requests.meetingId, id.parse(meetingId)),
        ),
      )
      .orderBy(asc(schema.requests.createdAt))
      .limit(100);
  }
  async command(actor: Actor, key: string, fingerprint: string, create: () => Promise<Capture>) {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${[this.workspaceId, actor.actorId, key].join(":")},0))`,
    );
    const old = (
      await this.db
        .select()
        .from(schema.commands)
        .where(
          and(
            eq(schema.commands.workspaceId, this.workspaceId),
            eq(schema.commands.actorId, actor.actorId),
            eq(schema.commands.key, key),
          ),
        )
    )[0];
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      const record = await this.load(old.requestId);
      if (!record) throw new AppError("NOT_FOUND", 404);
      return record;
    }
    const record = await create();
    await this.db.insert(schema.commands).values({
      workspaceId: this.workspaceId,
      actorId: actor.actorId,
      key,
      fingerprint,
      requestId: record.id,
    });
    return record;
  }
  async insert(input: { actor: Actor; context: CaptureContext; maxSeconds: number }) {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.workspaceId + ":meeting:" + input.context.meetingId},0))`,
    );
    const active = await this.db
      .select({ id: schema.requests.id })
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.workspaceId, this.workspaceId),
          eq(schema.requests.meetingId, input.context.meetingId),
          sql`state NOT IN ('complete','partial','failed','cancelled')`,
        ),
      )
      .limit(1);
    if (active.length) throw new AppError("ALREADY_CAPTURING", 409);
    const record = (
      await this.db
        .insert(schema.requests)
        .values({
          workspaceId: this.workspaceId,
          id: randomUUID(),
          meetingId: input.context.meetingId,
          ownerId: input.actor.actorId,
          sessionId: input.actor.sessionId,
          meetingVersion: input.context.version,
          joinUrl: input.context.joinUrl,
          maxSeconds: input.maxSeconds,
          attemptId: randomUUID(),
        })
        .returning()
    )[0]!;
    await this.db
      .insert(schema.directory)
      .values({ workspaceId: this.workspaceId, attemptId: record.attemptId, requestId: record.id });
    await this.db.execute(
      sql`INSERT INTO capture_work_index(request_id,workspace_id) VALUES(${record.id},${this.workspaceId})`,
    );
    return record;
  }
  async update(requestId: string, changes: Parameters<CaptureTransaction["update"]>[1]) {
    const record = (
      await this.db
        .update(schema.requests)
        .set({ ...changes, version: sql`${schema.requests.version}+1` })
        .where(
          and(eq(schema.requests.workspaceId, this.workspaceId), eq(schema.requests.id, requestId)),
        )
        .returning()
    )[0];
    if (!record) throw new AppError("NOT_FOUND", 404);
    return record;
  }
  async emit(capture: Capture, type: DomainEvent["type"], references?: DomainEvent["references"]) {
    const event = eventEnvelope.parse({
      eventId: randomUUID(),
      type,
      schemaVersion: 1,
      workspaceId: this.workspaceId,
      aggregateId: capture.id,
      aggregateVersion: capture.version,
      occurredAt: new Date().toISOString(),
      traceId: randomBytes(16).toString("hex"),
      actorId: capture.ownerId,
      references: references ?? [
        { kind: "meeting", id: capture.meetingId },
        { kind: "capture", id: capture.id },
      ],
    });
    await this.db
      .insert(schema.outbox)
      .values({ workspaceId: this.workspaceId, id: event.eventId, event });
  }
  async acceptMessage(source: string, messageId: string, digest: string) {
    const inserted = await this.db
      .insert(schema.inbox)
      .values({ workspaceId: this.workspaceId, source, messageId, digest })
      .onConflictDoNothing()
      .returning({ id: schema.inbox.messageId });
    if (inserted.length) return true;
    const old = (
      await this.db
        .select()
        .from(schema.inbox)
        .where(
          and(
            eq(schema.inbox.workspaceId, this.workspaceId),
            eq(schema.inbox.source, source),
            eq(schema.inbox.messageId, messageId),
          ),
        )
    )[0];
    if (!old || old.digest !== digest) throw new AppError("WEBHOOK_REPLAY_CONFLICT", 409);
    return false;
  }
  async storeSegment(requestId: string, segment: Omit<Segment, "workspaceId" | "requestId">) {
    const changed = await this.db
      .insert(schema.segments)
      .values({ workspaceId: this.workspaceId, requestId, ...segment })
      .onConflictDoUpdate({
        target: [schema.segments.workspaceId, schema.segments.requestId, schema.segments.id],
        set: {
          revision: segment.revision,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          speakerLabel: segment.speakerLabel,
          finalized: segment.finalized,
        },
        setWhere: sql`${schema.segments.revision}<${segment.revision}`,
      })
      .returning({ id: schema.segments.id });
    return changed.length > 0;
  }
  transcript(requestId: string, cursor?: { startMs: number; id: string }) {
    return this.db
      .select()
      .from(schema.segments)
      .where(
        and(
          eq(schema.segments.workspaceId, this.workspaceId),
          eq(schema.segments.requestId, requestId),
          cursor
            ? sql`(${schema.segments.startMs},${schema.segments.id})>(${cursor.startMs},${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(schema.segments.startMs), asc(schema.segments.id))
      .limit(101);
  }
  async segmentCount(requestId: string) {
    const result = await this.db.execute(
      sql`SELECT count(*)::integer AS count FROM transcript_segments WHERE workspace_id=${this.workspaceId} AND request_id=${requestId}`,
    );
    return Number(result.rows[0]!.count);
  }
}
export class PostgresCapture implements CaptureRepository {
  private readonly db: Database;
  constructor(pool: pg.Pool) {
    this.db = database(pool);
  }
  async due() {
    const result = await this.db.execute(
      sql`SELECT request_id AS "requestId",workspace_id AS "workspaceId" FROM capture_work_index WHERE next_at<=now() ORDER BY next_at,request_id LIMIT 20`,
    );
    return result.rows.map((row) => ({
      requestId: id.parse(row.requestId),
      workspaceId: id.parse(row.workspaceId),
    }));
  }
  async reschedule(workspaceId: string, requestId: string, seconds = 5) {
    const record = await this.scoped(workspaceId, (tx) => tx.load(requestId));
    if (
      !record ||
      (["complete", "partial", "failed", "cancelled"].includes(record.state) &&
        ["released", "settled"].includes(record.quotaState))
    ) {
      await this.db.execute(
        sql`DELETE FROM capture_work_index WHERE request_id=${requestId} AND workspace_id=${workspaceId}`,
      );
    } else {
      await this.db.execute(
        sql`UPDATE capture_work_index SET next_at=now()+${seconds}*interval '1 second' WHERE request_id=${requestId} AND workspace_id=${workspaceId}`,
      );
    }
  }
  scoped<T>(workspaceId: string, work: (tx: CaptureTransaction) => Promise<T>) {
    id.parse(workspaceId);
    return this.db.transaction(async (db) => {
      await db.execute(sql`SELECT set_config('app.workspace_id',${workspaceId},true)`);
      return work(new CaptureTx(db, workspaceId));
    });
  }
  attempt<T>(attemptId: string, work: (tx: CaptureTransaction, requestId: string) => Promise<T>) {
    id.parse(attemptId);
    return this.db.transaction(async (db) => {
      await db.execute(sql`SELECT set_config('app.attempt_id',${attemptId},true)`);
      const route = (
        await db.select().from(schema.directory).where(eq(schema.directory.attemptId, attemptId))
      )[0];
      if (!route) throw new AppError("UNKNOWN_CAPTURE_ATTEMPT", 404);
      await db.execute(sql`SELECT set_config('app.workspace_id',${route.workspaceId},true)`);
      return work(new CaptureTx(db, route.workspaceId), route.requestId);
    });
  }
}
