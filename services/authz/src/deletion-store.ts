import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, uuid, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import type pg from "pg";
import { AppError } from "@visualsprint/platform";
import type { AuthzDeletionRepository } from "./deletion-service.js";
const tombstones = pgTable(
  "meeting_tombstones",
  {
    workspaceId: uuid("workspace_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.meetingId] })],
);
const dbFor = (pool: pg.Pool) => drizzle(pool, { schema: { tombstones } });
type Tx = Parameters<Parameters<ReturnType<typeof dbFor>["transaction"]>[0]>[0];
export class PostgresAuthzDeletions implements AuthzDeletionRepository {
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
  async blocked(ws: string, meetingId: string) {
    return this.scoped(
      ws,
      async (tx) =>
        (await tx.execute(sql`SELECT 1 FROM meeting_tombstones WHERE meeting_id=${meetingId}`)).rows
          .length > 0,
    );
  }
  async begin(ws: string, deletionId: string, meetingId: string, sourceVersion: number) {
    return this.scoped(ws, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${ws + ":authz-deletion:" + deletionId},0))`,
      );
      const old = (
        await tx.execute(
          sql`SELECT meeting_id,source_version,completed FROM deletion_requests WHERE id=${deletionId}`,
        )
      ).rows[0];
      if (old && (old.meeting_id !== meetingId || Number(old.source_version) !== sourceVersion))
        throw new AppError("DELETION_TARGET_CONFLICT", 409);
      await tx.execute(
        sql`INSERT INTO meeting_tombstones(workspace_id,meeting_id,source_version) VALUES(${ws},${meetingId},${sourceVersion}) ON CONFLICT(workspace_id,meeting_id) DO UPDATE SET source_version=GREATEST(meeting_tombstones.source_version,EXCLUDED.source_version)`,
      );
      await tx.execute(
        sql`INSERT INTO deletion_requests(workspace_id,id,meeting_id,source_version) VALUES(${ws},${deletionId},${meetingId},${sourceVersion}) ON CONFLICT DO NOTHING`,
      );
      return { completed: old?.completed === true };
    });
  }
  async complete(ws: string, deletionId: string) {
    await this.scoped(ws, async (tx) => {
      await tx.execute(sql`UPDATE deletion_requests SET completed=true WHERE id=${deletionId}`);
    });
  }
}
