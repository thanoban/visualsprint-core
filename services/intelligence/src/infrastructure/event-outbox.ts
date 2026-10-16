import { randomUUID } from "node:crypto";
import type pg from "pg";
import { eventEnvelope, id, type DomainEvent } from "@visualsprint/contracts";

export class IntelligenceEventOutbox {
  constructor(private readonly pool: pg.Pool) {}
  private async scoped<T>(workspaceId: string, work: (db: pg.PoolClient) => Promise<T>) {
    id.parse(workspaceId);
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  async workspaces() {
    return (
      await this.pool.query(
        "SELECT workspace_id FROM intelligence_event_work_index WHERE next_at<=now() GROUP BY workspace_id ORDER BY min(next_at),workspace_id LIMIT 20",
      )
    ).rows.map((row) => String(row.workspace_id));
  }
  async defer(workspaceId: string, seconds: number) {
    id.parse(workspaceId);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
      throw new Error("INVALID_RETRY");
    await this.pool.query(
      "UPDATE intelligence_event_work_index SET next_at=now()+($2*interval '1 second') WHERE workspace_id=$1",
      [workspaceId, seconds],
    );
  }
  async publish(
    workspaceId: string,
    publisher: { publish(event: DomainEvent): Promise<void> },
    limit = 20,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("INVALID_BATCH_LIMIT");
    const token = randomUUID();
    const rows = await this.scoped(
      workspaceId,
      async (db) =>
        (
          await db.query(
            `WITH candidates AS (
        SELECT id FROM outbox WHERE published_at IS NULL AND (lease_until IS NULL OR lease_until<now())
        ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE outbox SET lease_token=$2,lease_until=now()+interval '30 seconds'
        FROM candidates WHERE outbox.id=candidates.id
        RETURNING outbox.id,outbox.event,outbox.created_at
      ) SELECT id,event FROM claimed ORDER BY created_at,id`,
            [limit, token],
          )
        ).rows,
    );
    let published = 0;
    for (const row of rows) {
      const event = eventEnvelope.parse(row.event);
      if (event.workspaceId !== workspaceId) throw new Error("OUTBOX_TENANT_MISMATCH");
      // Refresh each lease before I/O; a slow earlier delivery cannot dispatch a
      // later row after another publisher has acquired it. Deletion wins too.
      const current = await this.scoped(
        workspaceId,
        async (db) =>
          (
            await db.query(
              "UPDATE outbox SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND published_at IS NULL RETURNING id",
              [row.id, token],
            )
          ).rowCount,
      );
      if (!current) continue;
      await publisher.publish(event);
      published += await this.scoped(workspaceId, async (db) => {
        const ack = await db.query(
          "UPDATE outbox SET published_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND published_at IS NULL RETURNING id",
          [row.id, token],
        );
        if (ack.rowCount)
          await db.query(
            "DELETE FROM intelligence_event_work_index WHERE workspace_id=$1 AND event_id=$2",
            [workspaceId, row.id],
          );
        return ack.rowCount ?? 0;
      });
    }
    return published;
  }
}
