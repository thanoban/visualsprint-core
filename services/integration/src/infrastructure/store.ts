import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, asc, desc, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { id, eventEnvelope } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { ConnectionRepository, ConnectionTx } from "../application/ports.js";
import type { Connection } from "../domain/records.js";
import type { CalendarSync } from "../domain/sync.js";
import type { OccurrencePage } from "../domain/occurrences.js";
import type { CalendarChangePage, CalendarChangeRound } from "../domain/changes.js";
import * as schema from "./schema.js";
const database = (pool: pg.Pool) => drizzle(pool, { schema });
type Database = ReturnType<typeof database>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
class CalendarTx implements ConnectionTx {
  constructor(
    private readonly db: Transaction,
    private readonly workspaceId: string,
  ) {}
  async syncRequested(connectionId: string) {
    const result = await this.db.execute(
      sql`SELECT 1 FROM calendar_sync_signals s WHERE s.workspace_id=${this.workspaceId} AND s.connection_id=${connectionId} AND s.revision>coalesce((SELECT signal_revision FROM calendar_syncs WHERE workspace_id=s.workspace_id AND connection_id=s.connection_id ORDER BY sequence DESC LIMIT 1),0)`,
    );
    return result.rows.length > 0;
  }
  async changeRound(sync: CalendarSync): Promise<CalendarChangeRound> {
    const current = await this.latestSync(sync.connectionId, true);
    if (!current || current.id !== sync.id) throw new AppError("SYNC_FENCED", 409);
    const checkpoint = (
      await this.db.execute(
        sql`SELECT * FROM calendar_sync_checkpoints WHERE workspace_id=${this.workspaceId} AND connection_id=${sync.connectionId} AND calendar_id=${sync.calendarId} AND connection_version=${sync.connectionVersion}`,
      )
    ).rows[0];
    await this.db.execute(
      sql`INSERT INTO calendar_change_rounds(workspace_id,sync_id,phase,source_cursor,base_generation) VALUES(${this.workspaceId},${sync.id},'detecting',${sync.incremental && checkpoint ? checkpoint.source_cursor : null},${sync.incremental && checkpoint ? checkpoint.generation : null}) ON CONFLICT DO NOTHING`,
    );
    const row = (
      await this.db.execute(
        sql`SELECT * FROM calendar_change_rounds WHERE workspace_id=${this.workspaceId} AND sync_id=${sync.id} FOR UPDATE`,
      )
    ).rows[0]!;
    return {
      syncId: sync.id,
      phase: row.phase as CalendarChangeRound["phase"],
      sourceCursor: row.source_cursor ? String(row.source_cursor) : null,
      pageCursor: row.page_cursor ? String(row.page_cursor) : null,
      candidateCursor: row.candidate_cursor ? String(row.candidate_cursor) : null,
      baseGeneration: row.base_generation ? String(row.base_generation) : null,
      changed: Boolean(row.changed),
      pageCount: Number(row.page_count),
    };
  }
  async fallbackChanges(sync: CalendarSync, code: string) {
    await this.changeRound(sync);
    await this.db.execute(
      sql`UPDATE calendar_change_rounds SET phase='snapshot',candidate_cursor=NULL,error_code=${code} WHERE workspace_id=${this.workspaceId} AND sync_id=${sync.id}`,
    );
  }
  async changePage(sync: CalendarSync, page: CalendarChangePage) {
    const round = await this.changeRound(sync);
    if (round.phase !== "detecting") throw new AppError("SYNC_FENCED", 409);
    if (round.pageCount >= 20 || (round.pageCount === 19 && page.nextCursor))
      throw new AppError("CALENDAR_CHANGE_LIMIT", 409);
    if (Boolean(page.nextCursor) === Boolean(page.finalCursor))
      throw new AppError("INVALID_CHANGE_CURSOR", 503);
    const raw = (
      await this.db.execute(
        sql`SELECT cursor_hashes FROM calendar_change_rounds WHERE workspace_id=${this.workspaceId} AND sync_id=${sync.id}`,
      )
    ).rows[0]!;
    const hashes = raw.cursor_hashes as string[];
    if (page.nextCursor) {
      const digest = createHash("sha256").update(page.nextCursor).digest("hex");
      if (hashes.includes(digest)) throw new AppError("CALENDAR_CHANGE_LOOP", 409);
      hashes.push(digest);
    }
    const changed = round.changed || page.changed;
    const phase = page.nextCursor
      ? "detecting"
      : changed || !round.sourceCursor || !round.baseGeneration
        ? "snapshot"
        : "unchanged";
    await this.db.execute(
      sql`UPDATE calendar_change_rounds SET phase=${phase},changed=${changed},page_cursor=${page.nextCursor},candidate_cursor=${page.finalCursor},page_count=page_count+1,cursor_hashes=${JSON.stringify(hashes)}::jsonb WHERE workspace_id=${this.workspaceId} AND sync_id=${sync.id}`,
    );
    if (phase === "unchanged") {
      await this.db.execute(
        sql`INSERT INTO calendar_sync_stage(workspace_id,sync_id,source_key,body,fingerprint) SELECT workspace_id,${sync.id},source_key,body,fingerprint FROM calendar_occurrences WHERE workspace_id=${this.workspaceId} AND connection_id=${sync.connectionId} AND calendar_id=${sync.calendarId} AND generation=${round.baseGeneration} AND NOT EXISTS(SELECT 1 FROM calendar_suppressed_occurrences s WHERE s.workspace_id=calendar_occurrences.workspace_id AND s.connection_id=calendar_occurrences.connection_id AND s.calendar_id=calendar_occurrences.calendar_id AND s.source_key=calendar_occurrences.source_key) ON CONFLICT DO NOTHING`,
      );
    }
  }
  async queueSync(actor: Actor, key: string, connection: Connection, now: Date) {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.workspaceId + ":sync:" + actor.actorId + ":" + key},0))`,
    );
    const old = await this.db.execute(
      sql`SELECT connection_id,sync_id FROM calendar_sync_commands WHERE workspace_id=${this.workspaceId} AND actor_id=${actor.actorId} AND key=${key}`,
    );
    if (old.rows[0]) {
      if (old.rows[0].connection_id !== connection.id)
        throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      return (
        await this.db
          .select()
          .from(schema.syncs)
          .where(
            and(
              eq(schema.syncs.workspaceId, this.workspaceId),
              eq(schema.syncs.id, String(old.rows[0].sync_id)),
            ),
          )
      )[0]!;
    }
    if (await this.latestSync(connection.id, true)) throw new AppError("CALENDAR_SYNC_BUSY", 409);
    const checkpoint = (
      await this.db.execute(
        sql`SELECT * FROM calendar_sync_checkpoints WHERE workspace_id=${this.workspaceId} AND connection_id=${connection.id} AND calendar_id=${connection.calendarId} AND connection_version=${connection.version}`,
      )
    ).rows[0];
    const incremental = Boolean(
      actor.operationGrantId &&
        checkpoint?.source_cursor &&
        now.getTime() - new Date(String(checkpoint.last_full_at)).getTime() < 3600000,
    );
    const job: CalendarSync = {
      sequence: 0,
      workspaceId: this.workspaceId,
      id: randomUUID(),
      connectionId: connection.id,
      ownerId: actor.actorId,
      sessionId: actor.sessionId,
      operationGrantId: actor.operationGrantId ?? null,
      calendarId: connection.calendarId,
      connectionVersion: connection.version,
      startsAt: incremental ? new Date(String(checkpoint!.starts_at)) : now,
      endsAt: incremental
        ? new Date(String(checkpoint!.ends_at))
        : new Date(now.getTime() + 14 * 86400000),
      state: "queued",
      cursor: null,
      cursorHashes: [],
      pageCount: 0,
      errorCode: null,
      createdAt: now,
      incremental,
    };
    const { sequence: unused, ...insert } = job;
    const created = (await this.db.insert(schema.syncs).values(insert).returning())[0]!;
    await this.db.execute(
      sql`UPDATE calendar_syncs SET signal_revision=coalesce((SELECT revision FROM calendar_sync_signals WHERE workspace_id=${this.workspaceId} AND connection_id=${connection.id}),0) WHERE workspace_id=${this.workspaceId} AND id=${created.id}`,
    );
    await this.db.execute(
      sql`INSERT INTO calendar_sync_commands(workspace_id,actor_id,key,connection_id,sync_id) VALUES(${this.workspaceId},${actor.actorId},${key},${connection.id},${job.id})`,
    );
    await this.db.execute(
      sql`UPDATE connection_work_index SET next_at=now() WHERE workspace_id=${this.workspaceId} AND connection_id=${connection.id}`,
    );
    return created;
  }
  async latestSync(connectionId: string, activeOnly = false) {
    return (
      await this.db
        .select()
        .from(schema.syncs)
        .where(
          and(
            eq(schema.syncs.workspaceId, this.workspaceId),
            eq(schema.syncs.connectionId, connectionId),
            activeOnly ? inArray(schema.syncs.state, ["queued", "running"]) : undefined,
          ),
        )
        .orderBy(desc(schema.syncs.sequence))
        .limit(1)
        .for("update")
    )[0];
  }
  async endSync(sync: CalendarSync, state: "failed" | "blocked" | "superseded", code: string) {
    await this.db
      .update(schema.syncs)
      .set({ state, errorCode: code })
      .where(
        and(
          eq(schema.syncs.workspaceId, this.workspaceId),
          eq(schema.syncs.id, sync.id),
          inArray(schema.syncs.state, ["queued", "running"]),
        ),
      );
    await this.db.execute(
      sql`DELETE FROM calendar_sync_stage WHERE workspace_id=${this.workspaceId} AND sync_id=${sync.id}`,
    );
  }
  async syncPage(sync: CalendarSync, page: OccurrencePage) {
    const current = await this.latestSync(sync.connectionId, true);
    if (!current || current.id !== sync.id || current.pageCount !== sync.pageCount)
      throw new AppError("SYNC_FENCED", 409);
    if (
      page.items.length > 100 ||
      current.pageCount >= 20 ||
      (current.pageCount === 19 && page.nextCursor)
    )
      throw new AppError("CALENDAR_SYNC_LIMIT", 409);
    const hashes = [...current.cursorHashes];
    if (page.nextCursor) {
      const digest = createHash("sha256").update(page.nextCursor).digest("hex");
      if (hashes.includes(digest)) throw new AppError("CALENDAR_CURSOR_LOOP", 409);
      hashes.push(digest);
    }
    const values = page.items.map((item) => ({
      source_key: item.sourceKey,
      body: item,
      fingerprint: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
    }));
    const fingerprints = new Map<string, string>();
    for (const value of values) {
      if (
        fingerprints.has(value.source_key) &&
        fingerprints.get(value.source_key) !== value.fingerprint
      )
        throw new AppError("CALENDAR_INCONSISTENT_PAGE", 409);
      fingerprints.set(value.source_key, value.fingerprint);
    }
    const encoded = JSON.stringify(values);
    const inconsistent = await this.db
      .execute(sql`SELECT 1 FROM jsonb_to_recordset(${encoded}::jsonb) AS p(source_key text,body jsonb,fingerprint text)
      JOIN calendar_sync_stage s ON s.workspace_id=${this.workspaceId} AND s.sync_id=${sync.id} AND s.source_key=p.source_key WHERE s.fingerprint<>p.fingerprint LIMIT 1`);
    if (inconsistent.rows.length) throw new AppError("CALENDAR_INCONSISTENT_PAGE", 409);
    await this.db
      .execute(sql`INSERT INTO calendar_sync_stage(workspace_id,sync_id,source_key,body,fingerprint)
      SELECT ${this.workspaceId}::uuid,${sync.id}::uuid,p.source_key,p.body,p.fingerprint FROM jsonb_to_recordset(${encoded}::jsonb) AS p(source_key text,body jsonb,fingerprint text)
      WHERE NOT EXISTS(SELECT 1 FROM calendar_suppressed_occurrences s WHERE s.workspace_id=${this.workspaceId} AND s.connection_id=${sync.connectionId} AND s.calendar_id=${sync.calendarId} AND s.source_key=p.source_key) ON CONFLICT DO NOTHING`);
    if (!page.nextCursor) {
      // A full bounded snapshot proves missing in-window occurrences no longer eligible. Keep cancellation
      // evidence long enough for existing durable capture tasks to stop, rather than silently hiding it.
      await this.db
        .execute(sql`INSERT INTO calendar_sync_stage(workspace_id,sync_id,source_key,body,fingerprint)
        SELECT o.workspace_id,${sync.id},o.source_key,o.body||'{"status":"cancelled","joinUrl":null}'::jsonb,
          CASE WHEN o.body->>'status'='cancelled' THEN o.fingerprint ELSE 'cancelled:'||o.version::text END
        FROM calendar_occurrences o WHERE o.workspace_id=${this.workspaceId} AND o.connection_id=${sync.connectionId} AND o.calendar_id=${sync.calendarId}
        AND o.body->>'startsAt'<${sync.endsAt.toISOString()} AND o.body->>'endsAt'>${sync.startsAt.toISOString()}
        AND NOT EXISTS(SELECT 1 FROM calendar_sync_stage s WHERE s.workspace_id=o.workspace_id AND s.sync_id=${sync.id} AND s.source_key=o.source_key)
        AND NOT EXISTS(SELECT 1 FROM calendar_suppressed_occurrences s WHERE s.workspace_id=o.workspace_id AND s.connection_id=o.connection_id AND s.calendar_id=o.calendar_id AND s.source_key=o.source_key) ON CONFLICT DO NOTHING`);
      const changed = await this.db
        .execute(sql`INSERT INTO calendar_occurrences(workspace_id,id,connection_id,calendar_id,source_key,body,fingerprint,generation)
        SELECT p.workspace_id,gen_random_uuid(),${sync.connectionId},${sync.calendarId},p.source_key,p.body,p.fingerprint,${sync.id} FROM calendar_sync_stage p WHERE p.workspace_id=${this.workspaceId} AND p.sync_id=${sync.id}
        AND NOT EXISTS(SELECT 1 FROM calendar_suppressed_occurrences s WHERE s.workspace_id=p.workspace_id AND s.connection_id=${sync.connectionId} AND s.calendar_id=${sync.calendarId} AND s.source_key=p.source_key)
        ON CONFLICT(workspace_id,connection_id,calendar_id,source_key) DO UPDATE SET body=excluded.body,fingerprint=excluded.fingerprint,generation=excluded.generation,version=calendar_occurrences.version+1
        WHERE calendar_occurrences.fingerprint<>excluded.fingerprint
        AND NOT EXISTS(SELECT 1 FROM calendar_suppressed_occurrences s WHERE s.workspace_id=excluded.workspace_id AND s.connection_id=excluded.connection_id AND s.calendar_id=excluded.calendar_id AND s.source_key=excluded.source_key) RETURNING id,version`);
      await this.db.execute(
        sql`UPDATE calendar_occurrences o SET generation=${sync.id} FROM calendar_sync_stage s WHERE o.workspace_id=${this.workspaceId} AND o.connection_id=${sync.connectionId} AND o.calendar_id=${sync.calendarId} AND s.workspace_id=o.workspace_id AND s.sync_id=${sync.id} AND s.source_key=o.source_key`,
      );
      const events = changed.rows.map((row) => {
        const event = eventEnvelope.parse({
          eventId: randomUUID(),
          type: "calendar.occurrence.changed.v1",
          schemaVersion: 1,
          workspaceId: this.workspaceId,
          aggregateId: row.id,
          aggregateVersion: row.version,
          occurredAt: new Date().toISOString(),
          traceId: randomBytes(16).toString("hex"),
          actorId: sync.ownerId,
          references: [
            { kind: "connection", id: sync.connectionId },
            { kind: "occurrence", id: row.id, revision: row.version },
          ],
        });
        return { workspaceId: this.workspaceId, id: event.eventId, event };
      });
      if (events.length) await this.db.insert(schema.outbox).values(events);
      await this.db.execute(
        sql`DELETE FROM calendar_sync_stage WHERE workspace_id=${this.workspaceId} AND sync_id=${sync.id}`,
      );
      const round = (
        await this.db.execute(
          sql`SELECT * FROM calendar_change_rounds WHERE workspace_id=${this.workspaceId} AND sync_id=${sync.id}`,
        )
      ).rows[0];
      if (round)
        await this.db.execute(
          sql`INSERT INTO calendar_sync_checkpoints(workspace_id,connection_id,calendar_id,connection_version,source_cursor,generation,starts_at,ends_at,last_full_at) VALUES(${this.workspaceId},${sync.connectionId},${sync.calendarId},${sync.connectionVersion},${round.candidate_cursor},${sync.id},${sync.startsAt},${sync.endsAt},${sync.createdAt}) ON CONFLICT(workspace_id,connection_id,calendar_id) DO UPDATE SET connection_version=excluded.connection_version,source_cursor=excluded.source_cursor,generation=excluded.generation,starts_at=excluded.starts_at,ends_at=excluded.ends_at,last_full_at=CASE WHEN ${round.phase === "unchanged"} THEN calendar_sync_checkpoints.last_full_at ELSE excluded.last_full_at END`,
        );
    }
    await this.db
      .update(schema.syncs)
      .set({
        state: page.nextCursor ? "running" : "complete",
        cursor: page.nextCursor,
        cursorHashes: hashes,
        pageCount: current.pageCount + 1,
        errorCode: null,
      })
      .where(and(eq(schema.syncs.workspaceId, this.workspaceId), eq(schema.syncs.id, sync.id)));
  }
  async storedOccurrences(connectionId: string, calendarId: string, after?: string) {
    if (after) id.parse(after);
    const result = await this.db
      .execute(sql`SELECT o.id,o.version,o.body FROM calendar_occurrences o WHERE o.workspace_id=${this.workspaceId} AND o.connection_id=${connectionId} AND o.calendar_id=${calendarId}
      AND o.generation=(SELECT id FROM calendar_syncs WHERE workspace_id=${this.workspaceId} AND connection_id=${connectionId} AND calendar_id=${calendarId} AND state='complete' ORDER BY sequence DESC LIMIT 1)
      AND (${after ?? null}::uuid IS NULL OR o.id>${after ?? null}::uuid) ORDER BY o.id LIMIT 101`);
    return {
      items: result.rows
        .slice(0, 100)
        .map((row) => ({ id: row.id, version: row.version, ...(row.body as object) })),
      nextCursor: result.rows.length > 100 ? String(result.rows[99]!.id) : null,
    };
  }
  async storedOccurrence(connectionId: string, calendarId: string, occurrenceId: string) {
    const result = await this.db
      .execute(sql`SELECT o.id,o.version,o.body FROM calendar_occurrences o WHERE o.workspace_id=${this.workspaceId} AND o.connection_id=${connectionId} AND o.calendar_id=${calendarId} AND o.id=${id.parse(occurrenceId)}
      AND o.generation=(SELECT id FROM calendar_syncs WHERE workspace_id=${this.workspaceId} AND connection_id=${connectionId} AND calendar_id=${calendarId} AND state='complete' ORDER BY sequence DESC LIMIT 1)`);
    const row = result.rows[0];
    return row ? { id: row.id, version: row.version, ...(row.body as object) } : undefined;
  }
  async get(connectionId: string) {
    return (
      await this.db
        .select()
        .from(schema.connections)
        .where(
          and(
            eq(schema.connections.workspaceId, this.workspaceId),
            eq(schema.connections.id, id.parse(connectionId)),
          ),
        )
        .for("update")
    )[0];
  }
  list(ownerId: string) {
    return this.db
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, this.workspaceId),
          eq(schema.connections.ownerId, ownerId),
        ),
      )
      .orderBy(asc(schema.connections.createdAt))
      .limit(100);
  }
  async create(record: Connection) {
    const created = (await this.db.insert(schema.connections).values(record).returning())[0]!;
    await this.db.execute(
      sql`INSERT INTO connection_work_index(connection_id,workspace_id) VALUES(${record.id},${this.workspaceId})`,
    );
    return created;
  }
  async update(connectionId: string, changes: Parameters<ConnectionTx["update"]>[1]) {
    const meaningful = Object.keys(changes).some(
      (key) => !["leaseToken", "leaseUntil", "tokenCipher", "tokenExpiresAt"].includes(key),
    );
    const record = (
      await this.db
        .update(schema.connections)
        .set({
          ...changes,
          version: meaningful
            ? sql`${schema.connections.version}+1`
            : sql`${schema.connections.version}`,
        })
        .where(
          and(
            eq(schema.connections.workspaceId, this.workspaceId),
            eq(schema.connections.id, connectionId),
          ),
        )
        .returning()
    )[0];
    if (!record) throw new AppError("NOT_FOUND", 404);
    return record;
  }
  async command(actor: Actor, key: string, fingerprint: string, create: () => Promise<Connection>) {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.workspaceId + ":command:" + actor.actorId + ":" + key},0))`,
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
        .limit(1)
    )[0];
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      const record = await this.get(old.connectionId);
      if (!record || record.ownerId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
      return record;
    }
    const record = await create();
    await this.db.insert(schema.commands).values({
      workspaceId: this.workspaceId,
      actorId: actor.actorId,
      key,
      fingerprint,
      connectionId: record.id,
    });
    return record;
  }
  async emit(record: Connection) {
    const event = eventEnvelope.parse({
      eventId: randomUUID(),
      type: "calendar.connection.changed.v1",
      schemaVersion: 1,
      workspaceId: this.workspaceId,
      aggregateId: record.id,
      aggregateVersion: record.version,
      occurredAt: new Date().toISOString(),
      traceId: randomBytes(16).toString("hex"),
      actorId: record.ownerId,
      references: [{ kind: "connection", id: record.id }],
    });
    await this.db
      .insert(schema.outbox)
      .values({ workspaceId: this.workspaceId, id: event.eventId, event });
  }
}
export class PostgresCalendars implements ConnectionRepository {
  private readonly db: Database;
  constructor(pool: pg.Pool) {
    this.db = database(pool);
  }
  scoped<T>(workspaceId: string, work: (tx: ConnectionTx) => Promise<T>) {
    id.parse(workspaceId);
    return this.db.transaction(async (db) => {
      await db.execute(sql`SELECT set_config('app.workspace_id',${workspaceId},true)`);
      return work(new CalendarTx(db, workspaceId));
    });
  }
  async due() {
    const result = await this.db.execute(
      sql`SELECT workspace_id AS "workspaceId",connection_id AS "connectionId" FROM connection_work_index WHERE next_at<=now() ORDER BY next_at,connection_id LIMIT 20`,
    );
    return result.rows.map((row) => ({
      workspaceId: id.parse(row.workspaceId),
      connectionId: id.parse(row.connectionId),
    }));
  }
  async defer(workspaceId: string, connectionId: string, seconds: number) {
    id.parse(workspaceId);
    id.parse(connectionId);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
      throw new Error("INVALID_RETRY_DELAY");
    await this.db.execute(
      sql`UPDATE connection_work_index SET next_at=now()+${seconds}*interval '1 second' WHERE workspace_id=${workspaceId} AND connection_id=${connectionId}`,
    );
  }
}
