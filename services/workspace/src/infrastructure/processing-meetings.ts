import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Actor } from "@visualsprint/platform";
import type { ProcessingMeetings } from "../application/capture-processing-context.js";
export class PostgresProcessingMeetings implements ProcessingMeetings {
  private readonly db;
  constructor(pool: pg.Pool) {
    this.db = drizzle(pool);
  }
  metadata(actor: Actor, meetingId: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id',${actor.workspaceId},true)`);
      const row = (
        await tx.execute(
          sql`SELECT id,owner_id,version,blocked FROM meetings WHERE id=${meetingId}`,
        )
      ).rows[0];
      return row
        ? {
            id: String(row.id),
            ownerId: String(row.owner_id),
            version: Number(row.version),
            blocked: row.blocked === true,
          }
        : undefined;
    });
  }
}
