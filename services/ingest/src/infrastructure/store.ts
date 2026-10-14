import { randomUUID, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
    if (actor.operationGrantId) {
      const cancelled = await this.db.execute(
        sql`SELECT 1 FROM calendar_capture_tombstones WHERE workspace_id=${this.workspaceId} AND owner_id=${actor.actorId} AND key=${key}`,
      );
      if (cancelled.rows.length) throw new AppError("CALENDAR_CAPTURE_CANCELLED", 409);
    }
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
  async calendarCommand(actor: Actor, key: string, cancel: boolean) {
    if (!actor.operationGrantId || !key.startsWith(`calendar:${actor.operationGrantId}:`))
      throw new AppError("FORBIDDEN", 403);
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${[this.workspaceId, actor.actorId, key].join(":")},0))`,
    );
    if (cancel)
      await this.db.execute(
        sql`INSERT INTO calendar_capture_tombstones(workspace_id,owner_id,key,grant_id) VALUES(${this.workspaceId},${actor.actorId},${key},${actor.operationGrantId}) ON CONFLICT DO NOTHING`,
      );
    const command = (
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
    if (!command) return undefined;
    const record = await this.load(command.requestId);
    if (
      !record ||
      record.ownerId !== actor.actorId ||
      record.operationGrantId !== actor.operationGrantId
    )
      throw new AppError("FORBIDDEN", 403);
    return record;
  }
  async deleteMeeting(meetingId: string, deletionId: string, sourceVersion: number) {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.workspaceId + ":meeting:" + meetingId},0))`,
    );
    const existing = await this.db.execute(
      sql`SELECT meeting_id,deletion_id,source_version FROM meeting_deletions WHERE workspace_id=${this.workspaceId} AND (meeting_id=${meetingId} OR deletion_id=${deletionId})`,
    );
    if (
      existing.rows.some(
        (row) =>
          row.meeting_id !== meetingId ||
          row.deletion_id !== deletionId ||
          row.source_version !== sourceVersion,
      )
    )
      throw new AppError("DELETION_CONFLICT", 409);
    await this.db.execute(
      sql`INSERT INTO meeting_deletions(workspace_id,meeting_id,deletion_id,source_version) VALUES(${this.workspaceId},${meetingId},${deletionId},${sourceVersion}) ON CONFLICT DO NOTHING`,
    );
    const records = await this.db
      .select()
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.workspaceId, this.workspaceId),
          eq(schema.requests.meetingId, meetingId),
        ),
      )
      .for("update");
    for (const record of records) {
      const terminal = ["complete", "partial", "failed", "cancelled"].includes(record.state);
      const updated = await this.update(record.id, {
        stopRequested: true,
        state: terminal
          ? record.state
          : record.state === "scheduled"
            ? "cancelled"
            : record.state === "finalizing"
              ? "finalizing"
              : "stopping",
      });
      await this.db.execute(
        sql`UPDATE capture_requests SET join_url='https://deleted.invalid' WHERE workspace_id=${this.workspaceId} AND id=${record.id}`,
      );
      await this.emit(updated, "capture.state.changed.v1");
    }
    await this.db.execute(
      sql`DELETE FROM transcript_segments s USING capture_requests c WHERE s.workspace_id=${this.workspaceId} AND c.workspace_id=s.workspace_id AND c.id=s.request_id AND c.meeting_id=${meetingId}`,
    );
    return records.every(
      (record) =>
        ["complete", "partial", "failed", "cancelled"].includes(record.state) &&
        ["released", "settled"].includes(record.quotaState),
    );
  }
  async insert(input: {
    actor: Actor;
    context: CaptureContext;
    maxSeconds: number;
    dispatchNotBefore?: Date;
    processing?: boolean;
  }) {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.workspaceId + ":meeting:" + input.context.meetingId},0))`,
    );
    const deleted = await this.db.execute(
      sql`SELECT 1 FROM meeting_deletions WHERE workspace_id=${this.workspaceId} AND meeting_id=${input.context.meetingId}`,
    );
    if (deleted.rows.length) throw new AppError("MEETING_DELETED", 410);
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
          operationGrantId: input.actor.operationGrantId ?? null,
          meetingVersion: input.context.version,
          joinUrl: input.context.joinUrl,
          maxSeconds: input.maxSeconds,
          dispatchNotBefore: input.dispatchNotBefore ?? new Date(),
          attemptId: randomUUID(),
        })
        .returning()
    )[0]!;
    if (input.processing)
      await this.db.execute(
        sql`INSERT INTO capture_processing_intents(workspace_id,capture_id,meeting_id,owner_id,policy_version,state) VALUES(${this.workspaceId},${record.id},${record.meetingId},${record.ownerId},'english-text-v1','consent_pending')`,
      );
    await this.db
      .insert(schema.directory)
      .values({ workspaceId: this.workspaceId, attemptId: record.attemptId, requestId: record.id });
    await this.db.execute(
      sql`INSERT INTO capture_work_index(request_id,workspace_id,next_at) VALUES(${record.id},${this.workspaceId},GREATEST(now(),${record.dispatchNotBefore}))`,
    );
    return record;
  }
  async processingDispatchAllowed(requestId: string) {
    const result = await this.db.execute(
      sql`SELECT state FROM capture_processing_intents WHERE workspace_id=${this.workspaceId} AND capture_id=${id.parse(requestId)}`,
    );
    return !result.rows[0] || ["ready", "revoked"].includes(String(result.rows[0].state));
  }
  async update(requestId: string, changes: Parameters<CaptureTransaction["update"]>[1]) {
    const record = (
      await this.db
        .update(schema.requests)
        .set({
          ...changes,
          version: Object.keys(changes).some((key) => key !== "leaseUntil" && key !== "leaseToken")
            ? sql`${schema.requests.version}+1`
            : sql`${schema.requests.version}`,
        })
        .where(
          and(eq(schema.requests.workspaceId, this.workspaceId), eq(schema.requests.id, requestId)),
        )
        .returning()
    )[0];
    if (!record) throw new AppError("NOT_FOUND", 404);
    // A late reservation acknowledgement can reopen cleanup work after a stop
    // raced a scheduler removal. Enqueue in the same owning transaction.
    if (record.quotaState === "held" || record.quotaState === "pending")
      await this.db.execute(
        sql`INSERT INTO capture_work_index(request_id,workspace_id,next_at) VALUES(${requestId},${this.workspaceId},CASE WHEN ${record.state}='scheduled' THEN GREATEST(now(),${record.dispatchNotBefore}) ELSE now() END)
        ON CONFLICT(request_id) DO UPDATE SET next_at=excluded.next_at`,
      );
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
    if (!(await this.load(requestId))) throw new AppError("NOT_FOUND", 404);
    const deleted = await this.db.execute(
      sql`SELECT 1 FROM meeting_deletions d JOIN capture_requests c ON c.workspace_id=d.workspace_id AND c.meeting_id=d.meeting_id WHERE c.workspace_id=${this.workspaceId} AND c.id=${requestId}`,
    );
    if (deleted.rows.length) return false;
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
  evidence(requestId: string, segmentIds: string[]) {
    if (segmentIds.length < 1 || segmentIds.length > 20)
      throw new AppError("INVALID_EVIDENCE_BATCH", 400);
    return this.db
      .select()
      .from(schema.segments)
      .where(
        and(
          eq(schema.segments.workspaceId, this.workspaceId),
          eq(schema.segments.requestId, id.parse(requestId)),
          inArray(
            schema.segments.id,
            segmentIds.map((value) => id.parse(value)),
          ),
        ),
      )
      .limit(20);
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
  async eventWorkspaces() {
    const result = await this.db.execute(
      sql`SELECT workspace_id AS id FROM event_work_index WHERE next_at<=now() ORDER BY next_at,workspace_id LIMIT 20`,
    );
    return result.rows.map((row) => id.parse(row.id));
  }
  async deferEvents(workspaceId: string, seconds: number) {
    id.parse(workspaceId);
    await this.db.execute(
      sql`UPDATE event_work_index SET next_at=now()+${seconds}*interval '1 second' WHERE workspace_id=${workspaceId}`,
    );
  }
  async publish(workspaceId: string, publisher: { publish(event: DomainEvent): Promise<void> }) {
    const token = randomUUID();
    const rows = await this.db.transaction(async (db) => {
      await db.execute(sql`SELECT set_config('app.workspace_id',${id.parse(workspaceId)},true)`);
      return (
        await db.execute(sql`WITH candidates AS (SELECT id FROM outbox WHERE published_at IS NULL AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id LIMIT 20 FOR UPDATE SKIP LOCKED)
        UPDATE outbox SET lease_token=${token}::uuid,lease_until=now()+interval '30 seconds',attempts=attempts+1 FROM candidates WHERE outbox.id=candidates.id RETURNING outbox.id,outbox.event`)
      ).rows;
    });
    let count = 0;
    for (const row of rows) {
      await publisher.publish(eventEnvelope.parse(row.event));
      await this.db.transaction(async (db) => {
        await db.execute(sql`SELECT set_config('app.workspace_id',${workspaceId},true)`);
        const changed = await db
          .update(schema.outbox)
          .set({ publishedAt: new Date(), leaseUntil: null, leaseToken: null })
          .where(
            and(
              eq(schema.outbox.id, id.parse(row.id)),
              eq(schema.outbox.leaseToken, token),
              sql`${schema.outbox.publishedAt} IS NULL`,
            ),
          )
          .returning({ id: schema.outbox.id });
        count += changed.length;
      });
    }
    return count;
  }
  async reschedule(workspaceId: string, requestId: string, seconds = 5) {
    id.parse(workspaceId);
    id.parse(requestId);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
      throw new Error("INVALID_RETRY_DELAY");
    await this.db.transaction(async (db) => {
      await db.execute(sql`SELECT set_config('app.workspace_id',${workspaceId},true)`);
      const record = await new CaptureTx(db, workspaceId).load(requestId);
      if (
        !record ||
        (["complete", "partial", "failed", "cancelled"].includes(record.state) &&
          ["released", "settled"].includes(record.quotaState))
      ) {
        await db.execute(
          sql`DELETE FROM capture_work_index WHERE request_id=${requestId} AND workspace_id=${workspaceId}`,
        );
      } else {
        await db.execute(
          sql`UPDATE capture_work_index SET next_at=GREATEST(now()+${seconds}*interval '1 second',CASE WHEN ${record.state}='scheduled' THEN ${record.dispatchNotBefore} ELSE now() END) WHERE request_id=${requestId} AND workspace_id=${workspaceId}`,
        );
      }
    });
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
