import { randomUUID } from "node:crypto";
import type pg from "pg";
import { calendarMeeting, id } from "@visualsprint/contracts";
import { AppError } from "@visualsprint/platform";
import type {
  CalendarCaptureTasks,
  CalendarCaptureTask,
} from "../application/calendar-captures.js";
import type { Connection } from "../domain/records.js";
export class PostgresCalendarCaptureTasks implements CalendarCaptureTasks {
  constructor(private readonly pool: pg.Pool) {}
  purge(workspaceId: string, deletionId: string, meetingId: string, sourceVersion: number) {
    return this.scoped(workspaceId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        workspaceId + ":calendar-delete:" + deletionId,
      ]);
      const old = (
        await client.query(
          "SELECT meeting_id,source_version FROM calendar_deletion_requests WHERE workspace_id=$1 AND id=$2",
          [workspaceId, deletionId],
        )
      ).rows[0];
      if (old && (old.meeting_id !== meetingId || old.source_version !== sourceVersion))
        throw new AppError("DELETION_CONFLICT", 409);
      await client.query(
        "INSERT INTO calendar_deletion_requests(workspace_id,id,meeting_id,source_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [workspaceId, deletionId, meetingId, sourceVersion],
      );
      await client.query(
        `INSERT INTO calendar_suppressed_occurrences(workspace_id,connection_id,calendar_id,source_key)
        SELECT o.workspace_id,o.connection_id,o.calendar_id,o.source_key FROM calendar_occurrences o JOIN calendar_capture_tasks t ON t.workspace_id=o.workspace_id AND t.connection_id=o.connection_id AND t.occurrence_id=o.id
        WHERE t.workspace_id=$1 AND t.intent->>'meetingId'=$2 ON CONFLICT DO NOTHING`,
        [workspaceId, meetingId],
      );
      await client.query(
        `UPDATE calendar_occurrences o SET body=body||'{"title":"Deleted meeting","joinUrl":null,"status":"cancelled"}'::jsonb
        WHERE workspace_id=$1 AND EXISTS(SELECT 1 FROM calendar_suppressed_occurrences s WHERE s.workspace_id=o.workspace_id AND s.connection_id=o.connection_id AND s.calendar_id=o.calendar_id AND s.source_key=o.source_key)`,
        [workspaceId],
      );
      await client.query(
        `DELETE FROM calendar_sync_stage p USING calendar_syncs j,calendar_suppressed_occurrences s
        WHERE p.workspace_id=$1 AND j.workspace_id=p.workspace_id AND j.id=p.sync_id AND s.workspace_id=p.workspace_id AND s.connection_id=j.connection_id AND s.calendar_id=j.calendar_id AND s.source_key=p.source_key`,
        [workspaceId],
      );
      await client.query(
        `UPDATE calendar_capture_tasks SET enabled=false,target=target||'{"title":"Deleted meeting","joinUrl":null,"status":"cancelled"}'::jsonb,intent=NULL,lease_token=NULL,lease_until=NULL,next_at=now()
        WHERE workspace_id=$1 AND intent->>'meetingId'=$2`,
        [workspaceId, meetingId],
      );
    });
  }
  current(task: CalendarCaptureTask) {
    return this.scoped(task.workspaceId, async (client) => {
      const result = await client.query(
        `SELECT 1 FROM calendar_capture_tasks t JOIN connections c ON c.workspace_id=t.workspace_id AND c.id=t.connection_id
        WHERE t.workspace_id=$1 AND t.connection_id=$2 AND t.occurrence_id=$3 AND t.lease_token=$4 AND t.enabled AND c.automatic AND c.status='connected' AND c.grant_id=t.grant_id
        AND t.target->>'sourceVersion'=$5`,
        [
          task.workspaceId,
          task.connectionId,
          task.occurrenceId,
          task.leaseToken,
          String(task.target.sourceVersion),
        ],
      );
      return result.rows.length === 1;
    });
  }
  private async scoped<T>(
    workspaceId: string,
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    id.parse(workspaceId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
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
  refresh(connection: Connection) {
    return this.scoped(connection.workspaceId, async (client) => {
      // Lock current policy; a stale worker snapshot cannot re-enable revoked tasks.
      const current = (
        await client.query("SELECT * FROM connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [
          connection.workspaceId,
          connection.id,
        ])
      ).rows[0];
      if (!current?.automatic || current.status !== "connected" || !current.grant_id) {
        await client.query(
          "UPDATE calendar_capture_tasks SET enabled=false,next_at=LEAST(next_at,now()) WHERE workspace_id=$1 AND connection_id=$2",
          [connection.workspaceId, connection.id],
        );
        return;
      }
      await client.query(
        `INSERT INTO calendar_capture_tasks(workspace_id,connection_id,occurrence_id,owner_id,grant_id,target,enabled)
        SELECT o.workspace_id,o.connection_id,o.id,$3,$4,
          jsonb_build_object('connectionId',o.connection_id,'occurrenceId',o.id,'sourceVersion',o.version,'title',o.body->'title','joinUrl',o.body->'joinUrl','status',o.body->'status','allDay',o.body->'allDay','declined',o.body->'declined','startsAt',o.body->'startsAt','endsAt',o.body->'endsAt'),true
        FROM calendar_occurrences o WHERE o.workspace_id=$1 AND o.connection_id=$2 AND o.calendar_id=$5
          AND o.generation=(SELECT id FROM calendar_syncs WHERE workspace_id=$1 AND connection_id=$2 AND calendar_id=$5 AND state='complete' ORDER BY sequence DESC LIMIT 1)
        ON CONFLICT(workspace_id,connection_id,occurrence_id) DO UPDATE SET target=excluded.target,enabled=true
        WHERE (calendar_capture_tasks.target->>'sourceVersion')::integer <= (excluded.target->>'sourceVersion')::integer
        AND NOT EXISTS(SELECT 1 FROM calendar_suppressed_occurrences s WHERE s.workspace_id=excluded.workspace_id AND s.connection_id=excluded.connection_id AND s.source_key=(SELECT source_key FROM calendar_occurrences WHERE workspace_id=excluded.workspace_id AND id=excluded.occurrence_id))`,
        [
          connection.workspaceId,
          connection.id,
          current.owner_id,
          current.grant_id,
          current.calendar_id,
        ],
      );
      // A new grant must first finish the old grant's cleanup; it cannot inherit its capture.
      await client.query(
        "UPDATE calendar_capture_tasks SET enabled=false WHERE workspace_id=$1 AND connection_id=$2 AND grant_id<>$3",
        [connection.workspaceId, connection.id, current.grant_id],
      );
      await client.query(
        "UPDATE calendar_capture_tasks SET grant_id=$3,owner_id=$4,enabled=true,attempt=attempt+1 WHERE workspace_id=$1 AND connection_id=$2 AND grant_id<>$3 AND key IS NULL",
        [connection.workspaceId, connection.id, current.grant_id, current.owner_id],
      );
    });
  }
  claim(workspaceId: string, connectionId: string) {
    return this.scoped(workspaceId, async (client) => {
      const token = randomUUID();
      const result = await client.query(
        `UPDATE calendar_capture_tasks SET lease_token=$3,lease_until=now()+interval '30 seconds'
        WHERE (workspace_id,connection_id,occurrence_id) IN (SELECT workspace_id,connection_id,occurrence_id FROM calendar_capture_tasks
        WHERE workspace_id=$1 AND connection_id=$2 AND next_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY next_at,occurrence_id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
        [workspaceId, connectionId, token],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        workspaceId,
        connectionId,
        occurrenceId: id.parse(row.occurrence_id),
        ownerId: id.parse(row.owner_id),
        grantId: id.parse(row.grant_id),
        target: calendarMeeting.parse(row.target),
        enabled: row.enabled,
        attempt: row.attempt,
        key: row.key,
        intent: row.intent,
        intentFingerprint: row.intent_fingerprint,
        captureId: row.capture_id,
        leaseToken: token,
      };
    });
  }
  save(task: CalendarCaptureTask, changes: Parameters<CalendarCaptureTasks["save"]>[1]) {
    return this.scoped(task.workspaceId, async (client) => {
      const names = {
        attempt: "attempt",
        key: "key",
        intent: "intent",
        intentFingerprint: "intent_fingerprint",
        captureId: "capture_id",
      };
      const entries = Object.entries(changes) as [keyof typeof names, unknown][];
      if (!entries.length) return;
      const result = await client.query(
        `UPDATE calendar_capture_tasks SET ${entries.map(([key], i) => `${names[key]}=$${i + 5}${key === "intent" ? "::jsonb" : ""}`).join(",")} WHERE workspace_id=$1 AND connection_id=$2 AND occurrence_id=$3 AND lease_token=$4`,
        [
          task.workspaceId,
          task.connectionId,
          task.occurrenceId,
          task.leaseToken,
          ...entries.map(([key, value]) =>
            key === "intent" && value ? JSON.stringify(value) : value,
          ),
        ],
      );
      if (result.rowCount !== 1) throw new AppError("CAPTURE_ORCHESTRATION_FENCED", 409);
    });
  }
  release(task: CalendarCaptureTask) {
    return this.scoped(task.workspaceId, async (client) => {
      await client.query(
        "UPDATE calendar_capture_tasks SET lease_token=NULL,lease_until=NULL,next_at=now()+interval '30 seconds' WHERE workspace_id=$1 AND connection_id=$2 AND occurrence_id=$3 AND lease_token=$4",
        [task.workspaceId, task.connectionId, task.occurrenceId, task.leaseToken],
      );
    });
  }
}
