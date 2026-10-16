import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { eventEnvelope, type DomainEvent } from "@visualsprint/contracts";
import { AppError } from "@visualsprint/platform";
import type { NotificationTransaction, Repository } from "../application/ports.js";
import {
  nextDelivery,
  type Delivery,
  type Preferences,
  type NotificationKind,
} from "../domain/notification.js";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function preference(row: Record<string, unknown>): Preferences {
  return {
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    version: Number(row.version),
    inApp: Boolean(row.in_app),
    email: Boolean(row.email),
    deliveryHourUtc: row.delivery_hour_utc === null ? null : Number(row.delivery_hour_utc),
  };
}
function delivery(row: Record<string, unknown>): Delivery {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    meetingId: String(row.meeting_id),
    eventId: String(row.event_id),
    kind: row.kind as Delivery["kind"],
    sourceVersion: Number(row.source_version),
    channel: row.channel as Delivery["channel"],
    state: row.state as Delivery["state"],
    version: Number(row.version),
    leaseToken: row.lease_token ? String(row.lease_token) : null,
    availableAt: new Date(String(row.available_at)),
    externalId: row.external_id ? String(row.external_id) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    readAt: row.read_at ? new Date(String(row.read_at)) : null,
  };
}
class Transaction implements NotificationTransaction {
  constructor(
    private readonly db: pg.PoolClient,
    private readonly workspaceId: string,
  ) {}
  private async lock(reference: string) {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      this.workspaceId + ":notification:" + reference,
    ]);
  }
  private async clock() {
    // Scheduling and lease fences must use the same clock. API/worker clocks can differ from PG.
    return new Date((await this.db.query("SELECT clock_timestamp() AS now")).rows[0].now);
  }
  async preferences(userId: string) {
    const row = (
      await this.db.query("SELECT * FROM preferences WHERE workspace_id=$1 AND user_id=$2", [
        this.workspaceId,
        userId,
      ])
    ).rows[0];
    return row
      ? preference(row)
      : {
          workspaceId: this.workspaceId,
          userId,
          version: 0,
          inApp: false,
          email: false,
          deliveryHourUtc: null,
        };
  }
  async savePreferences(
    userId: string,
    key: string,
    expectedVersion: number,
    input: { inApp: boolean; email: boolean; deliveryHourUtc: number | null },
  ) {
    if (!key || key.length > 200) throw new AppError("INVALID_IDEMPOTENCY_KEY", 400);
    await this.lock("prefs:" + userId);
    const fingerprint = hash({ expectedVersion, ...input });
    const previous = (
      await this.db.query(
        "SELECT fingerprint FROM commands WHERE workspace_id=$1 AND user_id=$2 AND key=$3",
        [this.workspaceId, userId, key],
      )
    ).rows[0];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      return this.preferences(userId);
    }
    const current = await this.preferences(userId);
    if (current.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", 409);
    const row = (
      await this.db.query(
        "INSERT INTO preferences(workspace_id,user_id,version,in_app,email,delivery_hour_utc) VALUES($1,$2,1,$3,$4,$5) ON CONFLICT(workspace_id,user_id) DO UPDATE SET version=preferences.version+1,in_app=excluded.in_app,email=excluded.email,delivery_hour_utc=excluded.delivery_hour_utc RETURNING *",
        [this.workspaceId, userId, input.inApp, input.email, input.deliveryHourUtc],
      )
    ).rows[0];
    await this.db.query("INSERT INTO commands VALUES($1,$2,$3,$4)", [
      this.workspaceId,
      userId,
      key,
      fingerprint,
    ]);
    await this.db.query(
      "UPDATE deliveries SET state='cancelled',version=version+1,error_code='PREFERENCE_DISABLED',lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND user_id=$2 AND state IN('queued','held') AND((channel='in_app' AND NOT $3) OR(channel='email' AND NOT $4))",
      [this.workspaceId, userId, input.inApp, input.email],
    );
    if (input.email && current.deliveryHourUtc !== input.deliveryHourUtc) {
      const at = nextDelivery(await this.clock(), input.deliveryHourUtc);
      await this.db.query(
        "WITH changed AS(UPDATE deliveries SET available_at=$3,version=version+1 WHERE workspace_id=$1 AND user_id=$2 AND channel='email' AND state IN('queued','held') RETURNING workspace_id,id) UPDATE delivery_work_index SET next_at=$3 FROM changed WHERE delivery_work_index.workspace_id=changed.workspace_id AND delivery_work_index.delivery_id=changed.id",
        [this.workspaceId, userId, at],
      );
    }
    return preference(row);
  }
  async consume(event: DomainEvent) {
    const fingerprint = hash(event);
    await this.lock("event:" + event.eventId);
    const old = (
      await this.db.query("SELECT fingerprint FROM inbox WHERE workspace_id=$1 AND event_id=$2", [
        this.workspaceId,
        event.eventId,
      ])
    ).rows[0];
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError("EVENT_ID_CONFLICT", 409);
      return;
    }
    await this.db.query("INSERT INTO inbox(workspace_id,event_id,fingerprint) VALUES($1,$2,$3)", [
      this.workspaceId,
      event.eventId,
      fingerprint,
    ]);
    const kind: NotificationKind | null =
      event.type === "summary.ready.v1"
        ? "summary_ready"
        : event.type === "action.completed.v1"
          ? "action_completed"
          : event.type === "capture.state.changed.v1"
            ? "capture_updated"
            : null;
    const meeting = event.references.find((ref) => ref.kind === "meeting");
    if (!kind || !meeting || !event.actorId) return;
    await this.lock("source:" + meeting.id);
    if (
      (
        await this.db.query(
          "SELECT 1 FROM deletion_tombstones WHERE workspace_id=$1 AND meeting_id=$2",
          [this.workspaceId, meeting.id],
        )
      ).rowCount
    )
      return;
    const settings = await this.preferences(event.actorId);
    const now = await this.clock();
    for (const channel of ["in_app", "email"] as const) {
      if (channel === "in_app" ? !settings.inApp : !settings.email || kind === "capture_updated")
        continue;
      const id = randomUUID();
      const at = channel === "in_app" ? now : nextDelivery(now, settings.deliveryHourUtc);
      await this.db.query(
        "INSERT INTO deliveries(workspace_id,id,user_id,meeting_id,event_id,kind,source_version,channel,state,available_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9)",
        [
          this.workspaceId,
          id,
          event.actorId,
          meeting.id,
          event.eventId,
          kind,
          meeting.revision ?? event.aggregateVersion,
          channel,
          at,
        ],
      );
      await this.db.query(
        "INSERT INTO delivery_work_index(workspace_id,delivery_id,next_at) VALUES($1,$2,$3)",
        [this.workspaceId, id, at],
      );
    }
  }
  async delivery(id: string, userId?: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM deliveries WHERE workspace_id=$1 AND id=$2 AND($3::uuid IS NULL OR user_id=$3)",
        [this.workspaceId, id, userId ?? null],
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404);
    return delivery(row);
  }
  async list(userId: string, after?: string) {
    return (
      await this.db.query(
        "SELECT * FROM deliveries WHERE workspace_id=$1 AND user_id=$2 AND channel='in_app' AND state='delivered' AND($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 50",
        [this.workspaceId, userId, after ?? null],
      )
    ).rows.map(delivery);
  }
  async claim(id: string) {
    const row = (
      await this.db.query(
        "SELECT *,clock_timestamp() AS database_now FROM deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [this.workspaceId, id],
      )
    ).rows[0];
    if (
      !row ||
      ["delivered", "provider_sent", "failed", "cancelled"].includes(row.state) ||
      new Date(row.available_at) > new Date(row.database_now) ||
      (row.lease_until && new Date(row.lease_until) > new Date(row.database_now))
    )
      return null;
    const reconcile = row.channel === "email" && ["dispatching", "unknown"].includes(row.state);
    return delivery(
      (
        await this.db.query(
          "UPDATE deliveries SET state=$3,error_code=$4,lease_token=$5,lease_until=now()+interval '60 seconds',version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [
            this.workspaceId,
            id,
            reconcile ? "unknown" : row.state,
            reconcile ? "RECONCILE" : row.error_code,
            randomUUID(),
          ],
        )
      ).rows[0],
    );
  }
  async startEmail(current: Delivery) {
    // Same lock/order as savePreferences: opt-out and durable send intent serialize.
    await this.lock("prefs:" + current.userId);
    const row = (
      await this.db.query(
        "UPDATE deliveries SET state='dispatching',error_code=NULL WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>now() AND state IN('queued','held') AND channel='email' AND available_at<=now() AND EXISTS(SELECT 1 FROM preferences WHERE workspace_id=$1 AND user_id=$4 AND email=true) RETURNING id",
        [this.workspaceId, current.id, current.leaseToken, current.userId],
      )
    ).rows[0];
    if (!row) throw new AppError("STALE_WORKER", 409);
    await this.db.query(
      "INSERT INTO attempts(workspace_id,id,delivery_id,state) VALUES($1,$2,$3,'dispatching')",
      [this.workspaceId, randomUUID(), current.id],
    );
  }
  async finish(
    current: Delivery,
    state: Delivery["state"],
    code: string | null,
    externalId: string | null,
  ) {
    const updated = (
      await this.db.query(
        "UPDATE deliveries SET state=$4,error_code=$5,external_id=$6,version=version+1,lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>now() AND state NOT IN('cancelled','delivered','provider_sent','failed') RETURNING version",
        [this.workspaceId, current.id, current.leaseToken, state, code, externalId],
      )
    ).rows[0];
    if (!updated) throw new AppError("STALE_WORKER", 409);
    if (["unknown", "provider_sent", "failed"].includes(state) && current.channel === "email")
      await this.db.query(
        "INSERT INTO attempts(workspace_id,id,delivery_id,state,error_code,external_id) VALUES($1,$2,$3,$4,$5,$6)",
        [this.workspaceId, randomUUID(), current.id, state, code, externalId],
      );
    const event = eventEnvelope.parse({
      eventId: randomUUID(),
      type: "notification.delivery.changed.v1",
      schemaVersion: 1,
      workspaceId: this.workspaceId,
      aggregateId: current.id,
      aggregateVersion: updated.version,
      occurredAt: new Date().toISOString(),
      traceId: randomUUID().replaceAll("-", ""),
      actorId: current.userId,
      references: [
        { kind: "notification", id: current.id },
        { kind: "meeting", id: current.meetingId },
      ],
    });
    await this.db.query("INSERT INTO outbox(workspace_id,id,event) VALUES($1,$2,$3)", [
      this.workspaceId,
      event.eventId,
      JSON.stringify(event),
    ]);
    await this.db.query(
      "INSERT INTO event_work_index(workspace_id) VALUES($1) ON CONFLICT(workspace_id) DO UPDATE SET next_at=least(event_work_index.next_at,now())",
      [this.workspaceId],
    );
  }
  async markRead(id: string, userId: string, expectedVersion: number) {
    const old = await this.delivery(id, userId);
    if (old.channel !== "in_app" || old.state !== "delivered") throw new AppError("NOT_FOUND", 404);
    if (old.readAt) return old;
    const row = (
      await this.db.query(
        "UPDATE deliveries SET read_at=now(),version=version+1 WHERE workspace_id=$1 AND id=$2 AND user_id=$3 AND version=$4 RETURNING *",
        [this.workspaceId, id, userId, expectedVersion],
      )
    ).rows[0];
    if (!row) throw new AppError("VERSION_CONFLICT", 409);
    return delivery(row);
  }
  async deleteMeeting(deletionId: string, meetingId: string, sourceVersion: number) {
    await this.lock("source:" + meetingId);
    const old = (
      await this.db.query(
        "SELECT * FROM deletion_tombstones WHERE workspace_id=$1 AND(meeting_id=$2 OR deletion_id=$3)",
        [this.workspaceId, meetingId, deletionId],
      )
    ).rows[0];
    if (
      old &&
      (old.meeting_id !== meetingId ||
        old.deletion_id !== deletionId ||
        old.source_version !== sourceVersion)
    )
      throw new AppError("DELETION_TARGET_CONFLICT", 409);
    await this.db.query(
      "INSERT INTO deletion_tombstones(workspace_id,meeting_id,deletion_id,source_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [this.workspaceId, meetingId, deletionId, sourceVersion],
    );
    await this.db.query(
      "INSERT INTO cleanup_attempts(workspace_id,delivery_id,deletion_id,state,external_id) SELECT workspace_id,id,$3,state,external_id FROM deliveries WHERE workspace_id=$1 AND meeting_id=$2 AND channel='email' AND state IN('dispatching','unknown') ON CONFLICT DO NOTHING",
      [this.workspaceId, meetingId, deletionId],
    );
    await this.db.query("DELETE FROM deliveries WHERE workspace_id=$1 AND meeting_id=$2", [
      this.workspaceId,
      meetingId,
    ]);
    // Retire both published metadata and leased, not-yet-published events. A running publisher
    // must not restore the row or routing after this transaction commits.
    await this.db.query(
      "DELETE FROM outbox WHERE workspace_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(event->'references') ref WHERE ref->>'kind'='meeting' AND ref->>'id'=$2)",
      [this.workspaceId, meetingId],
    );
    await this.db.query(
      "DELETE FROM event_work_index WHERE workspace_id=$1 AND NOT EXISTS(SELECT 1 FROM outbox WHERE workspace_id=$1 AND published_at IS NULL)",
      [this.workspaceId],
    );
  }
}
export class PostgresNotifications implements Repository {
  constructor(private readonly pool: pg.Pool) {}
  async transaction<T>(workspaceId: string, work: (tx: NotificationTransaction) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
      const result = await work(new Transaction(client, workspaceId));
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
        "SELECT workspace_id,delivery_id FROM delivery_work_index WHERE next_at<=now() ORDER BY next_at,delivery_id LIMIT 50",
      )
    ).rows.map((row) => ({
      workspaceId: String(row.workspace_id),
      deliveryId: String(row.delivery_id),
    }));
  }
  async reschedule(workspaceId: string, deliveryId: string, seconds = 30) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
      throw new Error("INVALID_RETRY");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
      const row = (
        await client.query(
          "SELECT state,available_at FROM deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [workspaceId, deliveryId],
        )
      ).rows[0];
      if (!row || ["delivered", "provider_sent", "cancelled", "failed"].includes(row.state))
        await client.query(
          "DELETE FROM delivery_work_index WHERE workspace_id=$1 AND delivery_id=$2",
          [workspaceId, deliveryId],
        );
      else
        await client.query(
          "UPDATE delivery_work_index SET next_at=greatest(now()+($3*interval '1 second'),$4::timestamptz) WHERE workspace_id=$1 AND delivery_id=$2",
          [workspaceId, deliveryId, row.state === "held" ? 300 : seconds, row.available_at],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
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
      // Repair metadata left by a pre-fix deletion before claiming any external delivery.
      await client.query(
        "DELETE FROM outbox WHERE EXISTS(SELECT 1 FROM deletion_tombstones d JOIN jsonb_array_elements(outbox.event->'references') ref ON ref->>'kind'='meeting' AND ref->>'id'=d.meeting_id::text)",
      );
      rows = (
        await client.query(
          "WITH candidates AS(SELECT id FROM outbox WHERE published_at IS NULL AND(lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED),claimed AS(UPDATE outbox SET lease_token=$2,lease_until=now()+interval '30 seconds' FROM candidates WHERE outbox.id=candidates.id RETURNING outbox.id,outbox.event,outbox.created_at) SELECT id,event FROM claimed ORDER BY created_at,id",
          [limit, token],
        )
      ).rows;
      if (!rows.length)
        await client.query(
          "DELETE FROM event_work_index WHERE workspace_id=$1 AND NOT EXISTS(SELECT 1 FROM outbox WHERE published_at IS NULL)",
          [workspaceId],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    let count = 0;
    for (const row of rows) {
      const event = eventEnvelope.parse(row.event);
      if (event.workspaceId !== workspaceId) throw new Error("OUTBOX_TENANT_MISMATCH");
      const lease = await this.pool.connect();
      let live: number | null;
      try {
        await lease.query("BEGIN");
        await lease.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
        live = (
          await lease.query(
            "UPDATE outbox SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND published_at IS NULL AND NOT EXISTS(SELECT 1 FROM deletion_tombstones d JOIN jsonb_array_elements(outbox.event->'references') ref ON ref->>'kind'='meeting' AND ref->>'id'=d.meeting_id::text) RETURNING id",
            [row.id, token],
          )
        ).rowCount;
        await lease.query("COMMIT");
      } catch (error) {
        await lease.query("ROLLBACK");
        throw error;
      } finally {
        lease.release();
      }
      // Earlier I/O may have consumed this later row's lease, or deletion may have retired it.
      if (!live) continue;
      await publisher.publish(event);
      const ack = await this.pool.connect();
      try {
        await ack.query("BEGIN");
        await ack.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
        count +=
          (
            await ack.query(
              "UPDATE outbox SET published_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND published_at IS NULL AND NOT EXISTS(SELECT 1 FROM deletion_tombstones d JOIN jsonb_array_elements(outbox.event->'references') ref ON ref->>'kind'='meeting' AND ref->>'id'=d.meeting_id::text)",
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
    return count;
  }
}
