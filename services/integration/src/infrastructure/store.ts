import { randomUUID, randomBytes } from "node:crypto";
import { and, eq, asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { id, eventEnvelope } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { ConnectionRepository, ConnectionTx } from "../application/ports.js";
import type { Connection } from "../domain/records.js";
import * as schema from "./schema.js";
const database = (pool: pg.Pool) => drizzle(pool, { schema });
type Database = ReturnType<typeof database>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
class CalendarTx implements ConnectionTx {
  constructor(
    private readonly db: Transaction,
    private readonly workspaceId: string,
  ) {}
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
