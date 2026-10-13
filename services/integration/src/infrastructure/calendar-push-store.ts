import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { AppError } from "@visualsprint/platform";
import type {
  CalendarPushRepository,
  PushAttempt,
  PushResult,
} from "../application/calendar-push.js";
import type { Connection } from "../domain/records.js";
export class PostgresCalendarPush implements CalendarPushRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async scoped<T>(workspaceId: string, work: (db: pg.PoolClient) => Promise<T>) {
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
  private attempt(row: Record<string, unknown>, action: PushAttempt["action"]): PushAttempt {
    return {
      workspaceId: String(row.workspace_id),
      id: String(row.id),
      connectionId: String(row.connection_id),
      calendarId: String(row.calendar_id),
      connectionVersion: Number(row.connection_version),
      provider: row.provider as Connection["provider"],
      proofCipher: String(row.proof_cipher),
      requestedExpiresAt: new Date(String(row.requested_expires_at)),
      leaseToken: String(row.lease_token),
      externalId: row.external_id ? String(row.external_id) : null,
      resourceId: row.resource_id ? String(row.resource_id) : null,
      action,
    };
  }
  async plan(
    connection: Connection,
    now: Date,
    input: { id: string; proofHash: string; proofCipher: string; requestedExpiresAt: Date },
  ) {
    return this.scoped(connection.workspaceId, async (db) => {
      const current = (
        await db.query("SELECT * FROM connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [
          connection.workspaceId,
          connection.id,
        ])
      ).rows[0];
      if (
        !current?.automatic ||
        current.status !== "connected" ||
        !current.grant_id ||
        current.version !== connection.version ||
        current.lease_token !== connection.leaseToken ||
        !current.lease_until ||
        new Date(current.lease_until) <= now
      )
        return null;
      await db.query(
        "DELETE FROM calendar_push_inbox WHERE workspace_id=$1 AND created_at<now()-interval '7 days'",
        [connection.workspaceId],
      );
      await db.query(
        "UPDATE calendar_push_subscriptions SET state='retired',proof_cipher=NULL,lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND connection_id=$2 AND(state<>'retired') AND(connection_version<>$3 OR requested_expires_at<=$4)",
        [connection.workspaceId, connection.id, current.version, now],
      );
      const pending = (
        await db.query(
          "SELECT * FROM calendar_push_subscriptions WHERE workspace_id=$1 AND connection_id=$2 AND state IN('intent','unknown','failed') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
          [connection.workspaceId, connection.id],
        )
      ).rows[0];
      if (pending) {
        if (
          pending.state === "failed" ||
          (pending.lease_until && new Date(pending.lease_until) > now)
        )
          return null;
        const token = randomUUID();
        await db.query(
          "UPDATE calendar_push_subscriptions SET state='unknown',lease_token=$3,lease_until=$4 WHERE workspace_id=$1 AND id=$2",
          [connection.workspaceId, pending.id, token, new Date(now.getTime() + 30000)],
        );
        if (pending.provider !== "microsoft" || !pending.external_id) return null;
        return this.attempt({ ...pending, lease_token: token }, "reconcile");
      }
      const active = (
        await db.query(
          "SELECT * FROM calendar_push_subscriptions WHERE workspace_id=$1 AND connection_id=$2 AND state='active' ORDER BY expires_at DESC LIMIT 1 FOR UPDATE",
          [connection.workspaceId, connection.id],
        )
      ).rows[0];
      if (
        active &&
        !active.renewal_required &&
        new Date(active.expires_at).getTime() > now.getTime() + 3600000
      )
        return null;
      const lease = randomUUID();
      if (active && connection.provider === "microsoft") {
        const row = (
          await db.query(
            "UPDATE calendar_push_subscriptions SET state='intent',requested_expires_at=$3,lease_token=$4,lease_until=$5 WHERE workspace_id=$1 AND id=$2 RETURNING *",
            [
              connection.workspaceId,
              active.id,
              input.requestedExpiresAt,
              lease,
              new Date(now.getTime() + 30000),
            ],
          )
        ).rows[0];
        return this.attempt(row, "renew");
      }
      const row = (
        await db.query(
          "INSERT INTO calendar_push_subscriptions(workspace_id,id,connection_id,calendar_id,connection_version,provider,state,proof_hash,proof_cipher,requested_expires_at,lease_token,lease_until) VALUES($1,$2,$3,$4,$5,$6,'intent',$7,$8,$9,$10,$11) RETURNING *",
          [
            connection.workspaceId,
            input.id,
            connection.id,
            connection.calendarId,
            connection.version,
            connection.provider,
            input.proofHash,
            input.proofCipher,
            input.requestedExpiresAt,
            lease,
            new Date(now.getTime() + 30000),
          ],
        )
      ).rows[0];
      if (connection.provider === "google")
        await db.query("INSERT INTO calendar_push_route_index VALUES($1,$2,$3,$4)", [
          input.id,
          connection.workspaceId,
          input.id,
          connection.provider,
        ]);
      return this.attempt(row, "create");
    });
  }
  async finish(attempt: PushAttempt, result: PushResult) {
    await this.scoped(attempt.workspaceId, async (db) => {
      const current = (
        await db.query("SELECT * FROM connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [
          attempt.workspaceId,
          attempt.connectionId,
        ])
      ).rows[0];
      const valid =
        current?.automatic &&
        current.status === "connected" &&
        current.version === attempt.connectionVersion;
      const state = !valid ? "retired" : result.state;
      const active = result.state === "active" ? result : null;
      const updated = await db.query(
        "UPDATE calendar_push_subscriptions SET state=$4,external_id=coalesce($5,external_id),resource_id=coalesce($6,resource_id),expires_at=coalesce($7,expires_at),lease_token=NULL,lease_until=NULL,error_code=$8,proof_cipher=CASE WHEN $4='retired' THEN NULL ELSE proof_cipher END,renewal_required=$9 WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state IN('intent','unknown')",
        [
          attempt.workspaceId,
          attempt.id,
          attempt.leaseToken,
          state,
          active?.externalId ?? null,
          active?.resourceId ?? null,
          active?.expiresAt ?? null,
          result.state === "failed" ? result.code : null,
          Boolean(
            active &&
              attempt.action === "reconcile" &&
              active.expiresAt < attempt.requestedExpiresAt,
          ),
        ],
      );
      if (!updated.rowCount) throw new AppError("PUSH_FENCED", 409);
      if (valid && active) {
        const routed = await db.query(
          "INSERT INTO calendar_push_route_index VALUES($1,$2,$3,$4) ON CONFLICT(route_id) DO UPDATE SET route_id=excluded.route_id WHERE calendar_push_route_index.workspace_id=excluded.workspace_id AND calendar_push_route_index.subscription_id=excluded.subscription_id AND calendar_push_route_index.provider=excluded.provider RETURNING route_id",
          [active.externalId, attempt.workspaceId, attempt.id, attempt.provider],
        );
        if (!routed.rowCount) throw new AppError("PUSH_ROUTE_CONFLICT", 409);
        await db.query(
          "UPDATE calendar_push_subscriptions SET state='retired',proof_cipher=NULL WHERE workspace_id=$1 AND connection_id=$2 AND id<>$3 AND state='active'",
          [attempt.workspaceId, attempt.connectionId, attempt.id],
        );
        await db.query(
          "DELETE FROM calendar_push_route_index r USING calendar_push_subscriptions s WHERE r.workspace_id=$1 AND s.workspace_id=r.workspace_id AND s.id=r.subscription_id AND s.connection_id=$2 AND s.state='retired'",
          [attempt.workspaceId, attempt.connectionId],
        );
      }
    });
  }
  async retire(connection: Connection) {
    await this.scoped(connection.workspaceId, async (db) => {
      const current = (
        await db.query("SELECT * FROM connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [
          connection.workspaceId,
          connection.id,
        ])
      ).rows[0];
      if (current?.automatic && current.status === "connected") return;
      await db.query(
        "UPDATE calendar_push_subscriptions SET state='retired',proof_cipher=NULL,lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND connection_id=$2",
        [connection.workspaceId, connection.id],
      );
      await db.query(
        "DELETE FROM calendar_push_route_index r USING calendar_push_subscriptions s WHERE r.workspace_id=$1 AND s.workspace_id=r.workspace_id AND s.id=r.subscription_id AND s.connection_id=$2",
        [connection.workspaceId, connection.id],
      );
    });
  }
  private async signal(
    provider: Connection["provider"],
    routeId: string,
    proof: string,
    resourceId?: string,
    messageNumber?: string,
    lifecycle = false,
  ) {
    const route = (
      await this.pool.query(
        "SELECT workspace_id,subscription_id FROM calendar_push_route_index WHERE route_id=$1 AND provider=$2",
        [routeId, provider],
      )
    ).rows[0];
    if (!route) return;
    await this.scoped(String(route.workspace_id), async (db) => {
      const row = (
        await db.query(
          "SELECT s.*,c.automatic,c.status AS connection_status,c.version AS current_version,c.calendar_id AS current_calendar FROM calendar_push_subscriptions s JOIN connections c ON c.workspace_id=s.workspace_id AND c.id=s.connection_id WHERE s.workspace_id=$1 AND s.id=$2 FOR UPDATE OF c",
          [route.workspace_id, route.subscription_id],
        )
      ).rows[0];
      if (
        !row ||
        !["intent", "unknown", "active"].includes(row.state) ||
        !row.automatic ||
        row.connection_status !== "connected" ||
        row.current_version !== row.connection_version ||
        row.current_calendar !== row.calendar_id ||
        new Date(row.requested_expires_at) <= new Date() ||
        (row.expires_at && new Date(row.expires_at) <= new Date())
      )
        return;
      const actual = createHash("sha256").update(proof).digest();
      const expected = Buffer.from(row.proof_hash, "hex");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return;
      if (lifecycle)
        await db.query(
          "UPDATE calendar_push_subscriptions SET renewal_required=true WHERE workspace_id=$1 AND id=$2",
          [route.workspace_id, route.subscription_id],
        );
      if (provider === "google") {
        if (row.resource_id && row.resource_id !== resourceId) return;
        if (!row.resource_id)
          await db.query(
            "UPDATE calendar_push_subscriptions SET resource_id=$3 WHERE workspace_id=$1 AND id=$2",
            [route.workspace_id, route.subscription_id, resourceId],
          );
        // Message numbers need not be contiguous or delivered in order; dedupe exact hints only.
        const key = createHash("sha256")
          .update(routeId + ":" + messageNumber)
          .digest("hex");
        const seen = await db.query(
          "INSERT INTO calendar_push_inbox(workspace_id,key) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [route.workspace_id, key],
        );
        if (!seen.rowCount) return;
      }
      await db.query(
        "INSERT INTO calendar_sync_signals(workspace_id,connection_id,revision) VALUES($1,$2,1) ON CONFLICT(workspace_id,connection_id) DO UPDATE SET revision=calendar_sync_signals.revision+1",
        [route.workspace_id, row.connection_id],
      );
      await db.query(
        "UPDATE connection_work_index SET next_at=least(next_at,now()) WHERE workspace_id=$1 AND connection_id=$2",
        [route.workspace_id, row.connection_id],
      );
    });
  }
  async google(headers: Record<string, unknown>) {
    const parsed = z
      .object({
        "x-goog-channel-id": z.string().uuid(),
        "x-goog-channel-token": z.string().min(32).max(256),
        "x-goog-resource-id": z.string().min(1).max(2000),
        "x-goog-resource-state": z.enum(["sync", "exists", "not_exists"]),
        "x-goog-message-number": z.string().regex(/^\d{1,20}$/),
      })
      .parse(headers);
    await this.signal(
      "google",
      parsed["x-goog-channel-id"],
      parsed["x-goog-channel-token"],
      parsed["x-goog-resource-id"],
      parsed["x-goog-message-number"],
    );
  }
  async microsoft(body: unknown) {
    const parsed = z
      .object({
        value: z
          .array(
            z.object({
              subscriptionId: z.string().min(1).max(2000),
              clientState: z.string().min(32).max(256),
              changeType: z.enum(["created", "updated", "deleted"]).optional(),
              lifecycleEvent: z
                .enum(["reauthorizationRequired", "subscriptionRemoved", "missed"])
                .optional(),
            }),
          )
          .max(100),
      })
      .parse(body);
    for (const item of parsed.value)
      await this.signal(
        "microsoft",
        item.subscriptionId,
        item.clientState,
        undefined,
        undefined,
        Boolean(item.lifecycleEvent),
      );
  }
}
