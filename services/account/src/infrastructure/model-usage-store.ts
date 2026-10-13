import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError, type Actor } from "@visualsprint/platform";
import { id } from "@visualsprint/contracts";
import type {
  ModelUsageRepository,
  ModelUsageTransaction,
} from "../application/model-usage-ports.js";
import type {
  ModelReservation,
  ModelUsageRequest,
  ModelOutcome,
  ModelPurpose,
} from "../domain/model-usage.js";
function reservation(row: Record<string, unknown>): ModelReservation {
  return {
    workspaceId: String(row.workspace_id),
    reservationId: String(row.reservation_id),
    operationId: String(row.operation_id),
    ownerId: String(row.owner_id),
    purpose: row.purpose as ModelPurpose,
    maxInputTokens: Number(row.max_input_tokens),
    maxOutputTokens: Number(row.max_output_tokens),
    period: String(row.period),
    state: row.state as ModelReservation["state"],
  };
}
class ModelTx implements ModelUsageTransaction {
  constructor(
    private readonly db: pg.PoolClient,
    private readonly actor: Actor,
  ) {}
  async requireCurrent() {
    const row = (
      await this.db.query(
        "SELECT 1 FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.active AND NOT w.blocked AND NOT EXISTS(SELECT 1 FROM revoked_sessions WHERE user_id=$2 AND session_id=$3)",
        [this.actor.workspaceId, this.actor.actorId, this.actor.sessionId],
      )
    ).rows[0];
    if (!row) throw new AppError("FORBIDDEN", 403);
  }
  async lock(operationId: string, purpose: ModelPurpose) {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      this.actor.workspaceId + ":model-operation:" + operationId,
    ]);
    await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      this.actor.workspaceId + ":model:" + purpose,
    ]);
    // Operator-owned defaults/overrides: runtime may insert only workspace_id.
    await this.db.query(
      "INSERT INTO model_entitlements(workspace_id,purpose) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [this.actor.workspaceId, purpose],
    );
  }
  async budget(purpose: ModelPurpose) {
    const entitlement = (
      await this.db.query("SELECT * FROM model_entitlements WHERE workspace_id=$1 AND purpose=$2", [
        this.actor.workspaceId,
        purpose,
      ])
    ).rows[0];
    if (!entitlement) throw new AppError("MODEL_ENTITLEMENT_UNAVAILABLE", 503);
    const active = (
      await this.db.query(
        "SELECT count(*) AS active,coalesce(sum(max_input_tokens) FILTER(WHERE period=date_trunc('month',now() AT TIME ZONE 'UTC')::date),0) AS input,coalesce(sum(max_output_tokens) FILTER(WHERE period=date_trunc('month',now() AT TIME ZONE 'UTC')::date),0) AS output FROM model_reservations WHERE workspace_id=$1 AND purpose=$2 AND state IN('held','unknown')",
        [this.actor.workspaceId, purpose],
      )
    ).rows[0];
    const consumed = (
      await this.db.query(
        "SELECT coalesce(sum(estimated_input_tokens),0) AS input,coalesce(sum(estimated_output_tokens),0) AS output FROM model_estimate_ledger WHERE workspace_id=$1 AND purpose=$2 AND period=date_trunc('month',now() AT TIME ZONE 'UTC')::date",
        [this.actor.workspaceId, purpose],
      )
    ).rows[0];
    return {
      maxConcurrent: Number(entitlement.max_concurrent),
      monthlyInputTokens: Number(entitlement.monthly_input_tokens),
      monthlyOutputTokens: Number(entitlement.monthly_output_tokens),
      active: Number(active.active),
      reservedInputTokens: Number(active.input),
      reservedOutputTokens: Number(active.output),
      consumedInputTokens: Number(consumed.input),
      consumedOutputTokens: Number(consumed.output),
    };
  }
  async byOperation(operationId: string) {
    const row = (
      await this.db.query(
        "SELECT *,period::text AS period FROM model_reservations WHERE workspace_id=$1 AND operation_id=$2",
        [this.actor.workspaceId, operationId],
      )
    ).rows[0];
    return row ? reservation(row) : undefined;
  }
  async reservation(reservationId: string) {
    const row = (
      await this.db.query(
        "SELECT *,period::text AS period FROM model_reservations WHERE workspace_id=$1 AND reservation_id=$2",
        [this.actor.workspaceId, reservationId],
      )
    ).rows[0];
    return row ? reservation(row) : undefined;
  }
  async create(input: ModelUsageRequest) {
    return reservation(
      (
        await this.db.query(
          "INSERT INTO model_reservations(workspace_id,reservation_id,operation_id,owner_id,purpose,max_input_tokens,max_output_tokens) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *,period::text AS period",
          [
            this.actor.workspaceId,
            randomUUID(),
            input.operationId,
            this.actor.actorId,
            input.purpose,
            input.maxInputTokens,
            input.maxOutputTokens,
          ],
        )
      ).rows[0],
    );
  }
  async record(current: ModelReservation, outcome: ModelOutcome) {
    const row = (
      await this.db.query(
        "UPDATE model_reservations SET state=$3,updated_at=now() WHERE workspace_id=$1 AND reservation_id=$2 AND state=$4 RETURNING *,period::text AS period",
        [this.actor.workspaceId, current.reservationId, outcome, current.state],
      )
    ).rows[0];
    if (!row) throw new AppError("MODEL_OUTCOME_CONFLICT", 409);
    await this.db.query(
      "INSERT INTO model_outcome_ledger(workspace_id,reservation_id,outcome) VALUES($1,$2,$3)",
      [this.actor.workspaceId, current.reservationId, outcome],
    );
    if (outcome === "succeeded")
      await this.db.query(
        "INSERT INTO model_estimate_ledger(workspace_id,reservation_id,period,estimated_input_tokens,estimated_output_tokens,purpose) VALUES($1,$2,$3,$4,$5,$6)",
        [
          this.actor.workspaceId,
          current.reservationId,
          current.period,
          current.maxInputTokens,
          current.maxOutputTokens,
          current.purpose,
        ],
      );
    return reservation(row);
  }
}
export class PostgresModelUsage implements ModelUsageRepository {
  constructor(private readonly pool: pg.Pool) {}
  async transaction<T>(actor: Actor, work: (tx: ModelUsageTransaction) => Promise<T>) {
    id.parse(actor.actorId);
    id.parse(actor.workspaceId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.actor_id',$1,true),set_config('app.workspace_id',$2,true)",
        [actor.actorId, actor.workspaceId],
      );
      const result = await work(new ModelTx(client, actor));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
