import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError, type Actor } from "@visualsprint/platform";
import { eventEnvelope, type DomainEvent } from "@visualsprint/contracts";
import { fingerprint, type Action, type ActionInput, type Operation } from "../domain/action.js";
import type { WorkflowRepository, WorkflowTransaction } from "../application/ports.js";
function action(row: Record<string, unknown>): Action {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ownerId: String(row.owner_id),
    version: Number(row.version),
    state: row.state as Action["state"],
    input: row.input as ActionInput,
    payloadHash: String(row.payload_hash),
    approvalId: row.approval_id ? String(row.approval_id) : null,
  };
}
function operation(row: Record<string, unknown>): Operation {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    actionId: String(row.action_id),
    ownerId: String(row.owner_id),
    sessionId: String(row.session_id),
    state: row.state as Operation["state"],
    approvalId: String(row.approval_id),
    payloadHash: String(row.payload_hash),
    input: row.input as ActionInput,
    version: Number(row.version),
    externalId: row.external_id ? String(row.external_id) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    leaseToken: row.lease_token ? String(row.lease_token) : null,
  };
}
class Transaction implements WorkflowTransaction {
  constructor(
    private readonly db: pg.PoolClient,
    private readonly actor: Actor,
  ) {}
  private async lock(id: string) {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      this.actor.workspaceId + ":workflow:" + id,
    ]);
  }
  private async liveMeeting(meetingId: string) {
    await this.lock("source:" + meetingId);
    if (
      (
        await this.db.query(
          "SELECT 1 FROM deletion_tombstones WHERE workspace_id=$1 AND meeting_id=$2",
          [this.actor.workspaceId, meetingId],
        )
      ).rowCount
    )
      throw new AppError("NOT_FOUND", 404);
  }
  private async emit(
    type: DomainEvent["type"],
    aggregateId: string,
    aggregateVersion: number,
    actionId: string,
    meetingId: string,
  ) {
    const event = eventEnvelope.parse({
      eventId: randomUUID(),
      type,
      schemaVersion: 1,
      workspaceId: this.actor.workspaceId,
      aggregateId,
      aggregateVersion,
      occurredAt: new Date().toISOString(),
      traceId: randomUUID().replaceAll("-", ""),
      actorId: this.actor.actorId,
      references: [
        { kind: "action", id: actionId },
        { kind: "meeting", id: meetingId },
      ],
    });
    await this.db.query("INSERT INTO outbox(workspace_id,id,event) VALUES($1,$2,$3)", [
      this.actor.workspaceId,
      event.eventId,
      JSON.stringify(event),
    ]);
    await this.db.query(
      "INSERT INTO event_work_index(workspace_id) VALUES($1) ON CONFLICT(workspace_id) DO UPDATE SET next_at=least(event_work_index.next_at,now())",
      [this.actor.workspaceId],
    );
  }
  async command(actor: Actor, key: string, input: unknown, run: () => Promise<{ id: string }>) {
    if (key.length < 1 || key.length > 200) throw new AppError("INVALID_IDEMPOTENCY_KEY", 400);
    await this.lock(actor.actorId + ":" + key);
    const hash = fingerprint(input);
    const old = (
      await this.db.query(
        "SELECT * FROM commands WHERE workspace_id=$1 AND actor_id=$2 AND key=$3",
        [actor.workspaceId, actor.actorId, key],
      )
    ).rows[0];
    if (old) {
      if (old.fingerprint !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      return old.result as { id: string };
    }
    const result = await run();
    await this.db.query("INSERT INTO commands VALUES($1,$2,$3,$4,$5)", [
      actor.workspaceId,
      actor.actorId,
      key,
      hash,
      JSON.stringify({ id: result.id }),
    ]);
    return { id: result.id };
  }
  async createAction(actor: Actor, input: ActionInput) {
    await this.liveMeeting(input.source.meetingId);
    const row = (
      await this.db.query(
        "INSERT INTO actions(workspace_id,id,owner_id,version,state,input,payload_hash) VALUES($1,$2,$3,1,'draft',$4,$5) RETURNING *",
        [actor.workspaceId, randomUUID(), actor.actorId, JSON.stringify(input), fingerprint(input)],
      )
    ).rows[0];
    return action(row);
  }
  async action(id: string) {
    const row = (
      await this.db.query("SELECT * FROM actions WHERE workspace_id=$1 AND id=$2 AND owner_id=$3", [
        this.actor.workspaceId,
        id,
        this.actor.actorId,
      ])
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404);
    await this.liveMeeting(row.input.source.meetingId);
    const locked = (
      await this.db.query(
        "SELECT * FROM actions WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 FOR UPDATE",
        [this.actor.workspaceId, id, this.actor.actorId],
      )
    ).rows[0];
    if (!locked) throw new AppError("NOT_FOUND", 404);
    return action(locked);
  }
  async listActions(meetingId?: string) {
    return (
      await this.db.query(
        "SELECT * FROM actions WHERE workspace_id=$1 AND owner_id=$2 AND ($3::uuid IS NULL OR input->'source'->>'meetingId'=$3::text) ORDER BY id LIMIT 100",
        [this.actor.workspaceId, this.actor.actorId, meetingId ?? null],
      )
    ).rows.map(action);
  }
  private async noDispatch(id: string) {
    const busy = (
      await this.db.query(
        "SELECT 1 FROM operations WHERE workspace_id=$1 AND action_id=$2 AND state IN('dispatching','unknown','reconciling','confirmed') LIMIT 1",
        [this.actor.workspaceId, id],
      )
    ).rowCount;
    if (busy) throw new AppError("OPERATION_ALREADY_DISPATCHED", 409);
    await this.db.query(
      "UPDATE operations SET state='cancelled',version=version+1 WHERE workspace_id=$1 AND action_id=$2 AND state='queued'",
      [this.actor.workspaceId, id],
    );
  }
  async changeAction(id: string, expectedVersion: number, input: ActionInput) {
    const old = await this.action(id);
    if (old.input.source.meetingId !== input.source.meetingId)
      throw new AppError("SOURCE_TARGET_CHANGED", 409);
    if (old.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", 409);
    await this.noDispatch(id);
    return action(
      (
        await this.db.query(
          "UPDATE actions SET version=version+1,state='draft',input=$3,payload_hash=$4,approval_id=NULL WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [this.actor.workspaceId, id, JSON.stringify(input), fingerprint(input)],
        )
      ).rows[0],
    );
  }
  async approve(actor: Actor, id: string, expectedVersion: number) {
    const old = await this.action(id);
    if (old.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", 409);
    if (old.state === "approved") throw new AppError("ALREADY_APPROVED", 409);
    await this.noDispatch(id);
    const approvalId = randomUUID();
    await this.db.query(
      "INSERT INTO approvals(workspace_id,id,action_id,actor_id,payload_hash,source_meeting_id,source_revision,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        actor.workspaceId,
        approvalId,
        id,
        actor.actorId,
        old.payloadHash,
        old.input.source.meetingId,
        old.input.source.revision,
        JSON.stringify(old.input),
      ],
    );
    const result = action(
      (
        await this.db.query(
          "UPDATE actions SET state='approved',approval_id=$3,version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [actor.workspaceId, id, approvalId],
        )
      ).rows[0],
    );
    await this.emit(
      "action.approved.v1",
      result.id,
      result.version,
      result.id,
      result.input.source.meetingId,
    );
    return result;
  }
  async revoke(id: string, expectedVersion: number) {
    const old = await this.action(id);
    if (old.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", 409);
    await this.db.query(
      "UPDATE operations SET state='cancelled',version=version+1 WHERE workspace_id=$1 AND action_id=$2 AND state='queued'",
      [this.actor.workspaceId, id],
    );
    return action(
      (
        await this.db.query(
          "UPDATE actions SET state='revoked',version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [this.actor.workspaceId, id],
        )
      ).rows[0],
    );
  }
  async createOperation(actor: Actor, actionId: string, expectedVersion: number) {
    const current = await this.action(actionId);
    if (current.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", 409);
    if (current.state !== "approved" || !current.approvalId)
      throw new AppError("APPROVAL_REQUIRED", 409);
    const existing = (
      await this.db.query("SELECT * FROM operations WHERE workspace_id=$1 AND approval_id=$2", [
        actor.workspaceId,
        current.approvalId,
      ])
    ).rows[0];
    if (existing) return operation(existing);
    const row = (
      await this.db.query(
        "INSERT INTO operations(workspace_id,id,action_id,owner_id,session_id,approval_id,payload_hash,source_meeting_id,source_revision,input,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued') RETURNING *",
        [
          actor.workspaceId,
          randomUUID(),
          actionId,
          actor.actorId,
          actor.sessionId,
          current.approvalId,
          current.payloadHash,
          current.input.source.meetingId,
          current.input.source.revision,
          JSON.stringify(current.input),
        ],
      )
    ).rows[0];
    await this.db.query(
      "INSERT INTO operation_work_index(workspace_id,operation_id) VALUES($1,$2)",
      [actor.workspaceId, row.id],
    );
    return operation(row);
  }
  async deleteMeeting(deletionId: string, meetingId: string, sourceVersion: number) {
    await this.lock("source:" + meetingId);
    const existing = (
      await this.db.query(
        "SELECT * FROM deletion_tombstones WHERE workspace_id=$1 AND (meeting_id=$2 OR deletion_id=$3)",
        [this.actor.workspaceId, meetingId, deletionId],
      )
    ).rows[0];
    if (
      existing &&
      (existing.meeting_id !== meetingId ||
        existing.deletion_id !== deletionId ||
        existing.source_version !== sourceVersion)
    )
      throw new AppError("DELETION_TARGET_CONFLICT", 409);
    await this.db.query(
      "INSERT INTO deletion_tombstones(workspace_id,meeting_id,deletion_id,source_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [this.actor.workspaceId, meetingId, deletionId, sourceVersion],
    );
    await this.db.query("SELECT purge_meeting_actions($1,$2,$3,$4)", [
      this.actor.workspaceId,
      meetingId,
      deletionId,
      sourceVersion,
    ]);
  }
  async operation(id: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM operations WHERE workspace_id=$1 AND id=$2 AND owner_id=$3",
        [this.actor.workspaceId, id, this.actor.actorId],
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404);
    await this.liveMeeting(row.input.source.meetingId);
    return operation(row);
  }
  async operations(actionId: string) {
    const current = await this.action(actionId);
    return (
      await this.db.query(
        "SELECT * FROM operations WHERE workspace_id=$1 AND action_id=$2 AND owner_id=$3 AND approval_id=$4 ORDER BY id LIMIT 20",
        [this.actor.workspaceId, actionId, this.actor.actorId, current.approvalId],
      )
    ).rows.map(operation);
  }
  async claim(id: string) {
    const row = (
      await this.db.query("SELECT * FROM operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [
        this.actor.workspaceId,
        id,
      ])
    ).rows[0];
    if (
      !row ||
      ["confirmed", "rejected", "cancelled"].includes(row.state) ||
      (row.lease_until && new Date(row.lease_until).getTime() > Date.now())
    )
      return null;
    // Lock ordering is action then operation for all mutators. claim only locks operation; proof occurs in a fresh transaction.
    const state = row.state === "queued" ? "dispatching" : "reconciling";
    const token = randomUUID();
    return operation(
      (
        await this.db.query(
          "UPDATE operations SET state=$3,lease_token=$4,lease_until=now()+interval '60 seconds',version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [this.actor.workspaceId, id, state, token],
        )
      ).rows[0],
    );
  }
  async finish(
    old: Operation,
    state: Operation["state"],
    externalId: string | null,
    errorCode: string | null,
  ) {
    const row = (
      await this.db.query(
        "UPDATE operations SET state=$4,external_id=$5,error_code=$6,lease_token=NULL,lease_until=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 RETURNING version",
        [this.actor.workspaceId, old.id, old.leaseToken, state, externalId, errorCode],
      )
    ).rows[0];
    if (!row) throw new AppError("STALE_WORKER", 409);
    await this.emit(
      state === "confirmed" ? "action.completed.v1" : "action.reconciliation.required.v1",
      old.id,
      Number(row.version),
      old.actionId,
      old.input.source.meetingId,
    );
  }
  async approvalProof(id: string) {
    const op = await this.operation(id);
    const current = await this.action(op.actionId);
    if (
      current.state !== "approved" ||
      current.approvalId !== op.approvalId ||
      current.payloadHash !== op.payloadHash ||
      !["dispatching", "reconciling"].includes(op.state)
    )
      throw new AppError("APPROVAL_NO_LONGER_VALID", 409);
    return op;
  }
}
export class PostgresWorkflow implements WorkflowRepository {
  constructor(private readonly pool: pg.Pool) {}
  async eventWorkspaces() {
    return (
      await this.pool.query(
        "SELECT workspace_id FROM event_work_index WHERE next_at<=now() ORDER BY next_at,workspace_id LIMIT 20",
      )
    ).rows.map((row) => String(row.workspace_id));
  }
  async deferEvents(workspaceId: string, seconds: number) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
      throw new Error("INVALID_RETRY");
    await this.pool.query(
      "UPDATE event_work_index SET next_at=now()+($2*interval '1 second') WHERE workspace_id=$1",
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
    const client = await this.pool.connect();
    const token = randomUUID();
    let rows: { id: string; event: unknown }[];
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
      rows = (
        await client.query(
          "WITH candidates AS(SELECT id FROM outbox WHERE published_at IS NULL AND(lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE outbox SET lease_token=$2,lease_until=now()+interval '30 seconds' FROM candidates WHERE outbox.id=candidates.id RETURNING outbox.id,outbox.event",
          [limit, token],
        )
      ).rows;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    let published = 0;
    for (const row of rows) {
      await publisher.publish(eventEnvelope.parse(row.event));
      const ack = await this.pool.connect();
      try {
        await ack.query("BEGIN");
        await ack.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
        published +=
          (
            await ack.query(
              "UPDATE outbox SET published_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND published_at IS NULL",
              [row.id, token],
            )
          ).rowCount ?? 0;
        await ack.query("COMMIT");
      } catch (error) {
        await ack.query("ROLLBACK");
        throw error;
      } finally {
        ack.release();
      }
    }
    return published;
  }
  async transaction<T>(actor: Actor, run: (tx: WorkflowTransaction) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [actor.workspaceId]);
      const result = await run(new Transaction(client, actor));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async due() {
    return (
      await this.pool.query(
        "SELECT workspace_id,operation_id FROM operation_work_index WHERE next_at<=now() ORDER BY next_at,operation_id LIMIT 50",
      )
    ).rows.map((row) => ({
      workspaceId: String(row.workspace_id),
      operationId: String(row.operation_id),
    }));
  }
  async reschedule(workspaceId: string, operationId: string, seconds = 10) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
      throw new Error("INVALID_RETRY");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
      const row = (
        await client.query(
          "SELECT state FROM operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [workspaceId, operationId],
        )
      ).rows[0];
      if (!row || ["confirmed", "rejected", "cancelled"].includes(row.state))
        await client.query(
          "DELETE FROM operation_work_index WHERE workspace_id=$1 AND operation_id=$2",
          [workspaceId, operationId],
        );
      else
        await client.query(
          "UPDATE operation_work_index SET next_at=now()+($3*interval '1 second') WHERE workspace_id=$1 AND operation_id=$2",
          [workspaceId, operationId, seconds],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
