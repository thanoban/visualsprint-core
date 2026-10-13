import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { AppError, type Actor } from "@visualsprint/platform";
import {
  actionFingerprint,
  type ActionStore,
  type ActionConnection,
  type ActionExecution,
  type ExecutionIntent,
  type ExecutionResult,
} from "../application/action-executions.js";
const dbFor = (pool: pg.Pool) => drizzle(pool);
type Tx = Parameters<Parameters<ReturnType<typeof dbFor>["transaction"]>[0]>[0];
const connection = (r: Record<string, unknown>): ActionConnection => ({
  workspaceId: String(r.workspace_id),
  id: String(r.id),
  ownerId: String(r.owner_id),
  provider: r.provider as ActionConnection["provider"],
  destination: String(r.destination),
  configuration: r.configuration as ActionConnection["configuration"],
  credentialCipher: r.credential_cipher as string | null,
  status: r.status as ActionConnection["status"],
  version: Number(r.version),
});
const execution = (r: Record<string, unknown>): ActionExecution => ({
  workspaceId: String(r.workspace_id),
  id: String(r.id),
  ownerId: String(r.owner_id),
  sessionId: String(r.session_id),
  approvalId: String(r.approval_id),
  payloadHash: String(r.payload_hash),
  connectionId: String(r.connection_id),
  connectionVersion: Number(r.connection_version),
  meetingId: String(r.meeting_id),
  sourceRevision: Number(r.source_revision),
  provider: r.provider as ActionExecution["provider"],
  payload: r.payload as ExecutionIntent | null,
  state: r.state as ActionExecution["state"],
  externalId: r.external_id as string | null,
  errorCode: r.error_code as string | null,
  version: Number(r.version),
  leaseToken: r.lease_token as string | null,
});
export class PostgresActionExecutions implements ActionStore {
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
  async configure(actor: Actor, key: string, input: ActionConnection, fingerprint: string) {
    return this.scoped(actor.workspaceId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.workspaceId + ":action-config:" + actor.actorId + ":" + key},0))`,
      );
      const old = (
        await tx.execute(
          sql`SELECT * FROM action_connection_commands WHERE owner_id=${actor.actorId} AND key=${key}`,
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        return connection(
          (await tx.execute(sql`SELECT * FROM action_connections WHERE id=${old.connection_id}`))
            .rows[0]!,
        );
      }
      const row = (
        await tx.execute(
          sql`INSERT INTO action_connections(workspace_id,id,owner_id,provider,destination,configuration,credential_cipher,status) VALUES(${actor.workspaceId},${input.id},${actor.actorId},${input.provider},${input.destination},${JSON.stringify(input.configuration)}::jsonb,${input.credentialCipher},'configured') RETURNING *`,
        )
      ).rows[0]!;
      await tx.execute(
        sql`INSERT INTO action_connection_commands(workspace_id,owner_id,key,fingerprint,connection_id) VALUES(${actor.workspaceId},${actor.actorId},${key},${fingerprint},${input.id})`,
      );
      return connection(row);
    });
  }
  async connections(actor: Actor) {
    return this.scoped(actor.workspaceId, async (tx) =>
      (
        await tx.execute(
          sql`SELECT * FROM action_connections WHERE owner_id=${actor.actorId} ORDER BY id LIMIT 100`,
        )
      ).rows.map(connection),
    );
  }
  async connection(ws: string, connectionId: string) {
    return this.scoped(ws, async (tx) => {
      const row = (await tx.execute(sql`SELECT * FROM action_connections WHERE id=${connectionId}`))
        .rows[0];
      return row ? connection(row) : undefined;
    });
  }
  async disconnect(actor: Actor, connectionId: string, expectedVersion: number) {
    return this.scoped(actor.workspaceId, async (tx) => {
      const row = (
        await tx.execute(
          sql`SELECT * FROM action_connections WHERE id=${connectionId} AND owner_id=${actor.actorId} FOR UPDATE`,
        )
      ).rows[0];
      if (!row) throw new AppError("NOT_FOUND", 404);
      if (row.status === "disconnected") return connection(row);
      if (Number(row.version) !== expectedVersion) throw new AppError("VERSION_CONFLICT", 409);
      return connection(
        (
          await tx.execute(
            sql`UPDATE action_connections SET status='disconnected',credential_cipher=NULL,version=version+1 WHERE id=${connectionId} RETURNING *`,
          )
        ).rows[0]!,
      );
    });
  }
  async prepare(actor: Actor, intent: ExecutionIntent, source: ActionConnection) {
    return this.scoped(actor.workspaceId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.workspaceId + ":action-execution:" + intent.operationId},0))`,
      );
      if (
        (
          await tx.execute(
            sql`SELECT 1 FROM action_deletion_tombstones WHERE meeting_id=${intent.source.meetingId}`,
          )
        ).rows.length
      )
        throw new AppError("NOT_FOUND", 404);
      const old = (
        await tx.execute(sql`SELECT * FROM action_executions WHERE id=${intent.operationId}`)
      ).rows[0];
      if (old) {
        const record = execution(old);
        if (
          record.ownerId !== actor.actorId ||
          !record.payload ||
          actionFingerprint(record.payload) !== actionFingerprint(intent)
        )
          throw new AppError("EXECUTION_PAYLOAD_MISMATCH", 409);
        return record;
      }
      const current = (
        await tx.execute(
          sql`SELECT * FROM action_connections WHERE id=${source.id} AND owner_id=${actor.actorId} AND version=${source.version} AND status='configured' FOR SHARE`,
        )
      ).rows[0];
      if (!current) throw new AppError("ACTION_CONNECTION_CHANGED", 409);
      if (
        (
          await tx.execute(
            sql`SELECT 1 FROM action_executions WHERE approval_id=${intent.approvalId}`,
          )
        ).rows.length
      )
        throw new AppError("APPROVAL_ALREADY_EXECUTED", 409);
      return execution(
        (
          await tx.execute(
            sql`INSERT INTO action_executions(workspace_id,id,owner_id,session_id,approval_id,payload_hash,connection_id,connection_version,meeting_id,source_revision,provider,payload,state) VALUES(${actor.workspaceId},${intent.operationId},${actor.actorId},${actor.sessionId},${intent.approvalId},${intent.payloadHash},${source.id},${source.version},${intent.source.meetingId},${intent.source.revision},${intent.provider},${JSON.stringify(intent)}::jsonb,'prepared') RETURNING *`,
          )
        ).rows[0]!,
      );
    });
  }
  async get(ws: string, operationId: string) {
    return this.scoped(ws, async (tx) => {
      const row = (await tx.execute(sql`SELECT * FROM action_executions WHERE id=${operationId}`))
        .rows[0];
      return row ? execution(row) : undefined;
    });
  }
  async claim(record: ActionExecution) {
    return this.scoped(record.workspaceId, async (tx) => {
      const row = (
        await tx.execute(
          sql`UPDATE action_executions SET state='dispatching',lease_token=${randomUUID()},version=version+1 WHERE id=${record.id} AND state='prepared' AND version=${record.version} AND NOT EXISTS(SELECT 1 FROM action_deletion_tombstones d WHERE d.meeting_id=action_executions.meeting_id) RETURNING *`,
        )
      ).rows[0];
      return row ? execution(row) : undefined;
    });
  }
  async finish(record: ActionExecution, result: ExecutionResult) {
    await this.scoped(record.workspaceId, async (tx) => {
      const state =
        result.state === "confirmed"
          ? "confirmed"
          : result.state === "rejected"
            ? "rejected"
            : "unknown";
      await tx.execute(
        sql`UPDATE action_executions SET state=CASE WHEN state='deleted' THEN 'deleted' ELSE ${state} END,external_id=CASE WHEN ${result.state === "confirmed"} THEN ${result.state === "confirmed" ? result.externalId : null} ELSE external_id END,error_code=CASE WHEN state='deleted' THEN NULL ELSE ${result.state === "rejected" ? result.code : null} END,lease_token=NULL,version=version+1 WHERE id=${record.id} AND ((state='dispatching' AND lease_token=${record.leaseToken}) OR (state='deleted' AND payload_hash=${record.payloadHash} AND external_id IS NULL))`,
      );
    });
  }
  async confirmReference(record: ActionExecution, externalId: string) {
    await this.scoped(record.workspaceId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${record.workspaceId + ":external-ref:" + record.connectionId + ":" + externalId},0))`,
      );
      if (
        (
          await tx.execute(
            sql`SELECT 1 FROM action_executions WHERE connection_id=${record.connectionId} AND external_id=${externalId} AND id<>${record.id}`,
          )
        ).rows.length
      )
        throw new AppError("EXTERNAL_REFERENCE_ALREADY_BOUND", 409);
      const row = (
        await tx.execute(
          sql`UPDATE action_executions SET state='confirmed',external_id=${externalId},lease_token=NULL,version=version+1 WHERE id=${record.id} AND version=${record.version} AND state IN('dispatching','unknown') AND NOT EXISTS(SELECT 1 FROM action_deletion_tombstones d WHERE d.meeting_id=action_executions.meeting_id) RETURNING id`,
        )
      ).rows[0];
      if (!row) throw new AppError("EXECUTION_VERSION_CHANGED", 409);
    });
  }
  async remove(ws: string, deletionId: string, meetingId: string, sourceVersion: number) {
    return this.scoped(ws, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${ws + ":action-deletion:" + deletionId},0))`,
      );
      const old = (
        await tx.execute(sql`SELECT * FROM action_deletion_requests WHERE id=${deletionId}`)
      ).rows[0];
      if (old && (old.meeting_id !== meetingId || Number(old.source_version) !== sourceVersion))
        throw new AppError("DELETION_TARGET_CONFLICT", 409);
      await tx.execute(
        sql`INSERT INTO action_deletion_requests(workspace_id,id,meeting_id,source_version) VALUES(${ws},${deletionId},${meetingId},${sourceVersion}) ON CONFLICT DO NOTHING`,
      );
      await tx.execute(
        sql`INSERT INTO action_deletion_tombstones(workspace_id,meeting_id,source_version) VALUES(${ws},${meetingId},${sourceVersion}) ON CONFLICT(workspace_id,meeting_id) DO UPDATE SET source_version=GREATEST(action_deletion_tombstones.source_version,EXCLUDED.source_version)`,
      );
      await tx.execute(
        sql`UPDATE action_executions SET external_cleanup_state=CASE WHEN state IN('dispatching','unknown','confirmed') THEN 'pending' ELSE external_cleanup_state END,state='deleted',payload=NULL,lease_token=NULL,version=version+1 WHERE meeting_id=${meetingId} AND state<>'deleted'`,
      );
      const pending =
        (
          await tx.execute(
            sql`SELECT 1 FROM action_executions WHERE meeting_id=${meetingId} AND external_cleanup_state='pending' LIMIT 1`,
          )
        ).rows.length > 0;
      return pending ? "pending" : "not_required";
    });
  }
}
