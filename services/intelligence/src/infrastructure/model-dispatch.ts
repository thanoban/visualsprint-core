import type pg from "pg";
import { id } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
export class PostgresModelDispatch {
  constructor(private readonly pool: pg.Pool) {}
  private async scoped<T>(actor: Actor, work: (client: pg.PoolClient) => Promise<T>) {
    id.parse(actor.workspaceId);
    id.parse(actor.actorId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [actor.workspaceId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async intent(actor: Actor, operationId: string, reservationId: string) {
    return this.scoped(actor, async (client) => {
      const result = await client.query(
        `INSERT INTO model_dispatches(workspace_id,operation_id,owner_id,reservation_id,state)
        VALUES($1,$2,$3,$4,'dispatch_intent') ON CONFLICT(workspace_id,operation_id) DO NOTHING RETURNING operation_id`,
        [actor.workspaceId, id.parse(operationId), actor.actorId, id.parse(reservationId)],
      );
      if (result.rowCount !== 1) throw new AppError("MODEL_DISPATCH_REPLAY", 409);
    });
  }
  async record(
    actor: Actor,
    reservationId: string,
    outcome: "succeeded" | "unknown" | "not_started",
  ) {
    await this.scoped(actor, async (client) => {
      const result = await client.query(
        `UPDATE model_dispatches SET state=$1
        WHERE workspace_id=$2 AND owner_id=$3 AND reservation_id=$4 AND state IN ('dispatch_intent',$1) RETURNING operation_id`,
        [outcome, actor.workspaceId, actor.actorId, id.parse(reservationId)],
      );
      if (result.rowCount !== 1) throw new AppError("MODEL_DISPATCH_RECORD_CONFLICT", 409);
    });
  }
}
