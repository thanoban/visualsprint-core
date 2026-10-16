import { randomUUID, randomBytes } from "node:crypto";
import type pg from "pg";
import { AppError, type Actor } from "@visualsprint/platform";
import { eventEnvelope, id } from "@visualsprint/contracts";
import {
  agendaFingerprint,
  type AgendaStore,
  type AgendaCommand,
  type AgendaDTO,
  type AgendaSnapshot,
} from "../application/agendas.js";
const dto = (row: Record<string, unknown>): AgendaDTO => ({
  id: String(row.id),
  meetingId: String(row.meeting_id),
  title: String(row.title),
  body: String(row.body),
  version: Number(row.version),
  reviewed: true,
  createdAt: new Date(row.created_at as string).toISOString(),
  updatedAt: new Date(row.updated_at as string).toISOString(),
});
export class PostgresAgendas implements AgendaStore {
  constructor(private readonly pool: pg.Pool) {}
  private async scoped<T>(
    actor: Actor,
    readonly: boolean,
    work: (db: pg.PoolClient) => Promise<T>,
  ) {
    id.parse(actor.workspaceId);
    id.parse(actor.actorId);
    const db = await this.pool.connect();
    try {
      await db.query(readonly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      await db.query("SELECT set_config('app.workspace_id',$1,true)", [actor.workspaceId]);
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
  private async meeting(db: pg.PoolClient, actor: Actor, meetingId: string, owner: boolean) {
    const row = (
      await db.query(
        `SELECT id,owner_id,version FROM meetings m WHERE workspace_id=$1 AND id=$2 AND NOT blocked AND (owner_id=$3 OR (NOT $4::boolean AND EXISTS(SELECT 1 FROM meeting_readers r WHERE r.workspace_id=m.workspace_id AND r.meeting_id=m.id AND r.user_id=$3))) ${owner ? "FOR UPDATE" : ""}`,
        [actor.workspaceId, meetingId, actor.actorId, owner],
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404);
    return row;
  }
  command(actor: Actor, key: string, command: AgendaCommand) {
    return this.scoped(actor, false, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${actor.workspaceId}:agenda-command:${actor.actorId}:${key}`,
      ]);
      const meeting = await this.meeting(db, actor, command.meetingId, true),
        fingerprint = agendaFingerprint(command);
      const old = (
        await db.query(
          "SELECT * FROM agenda_commands WHERE workspace_id=$1 AND actor_id=$2 AND key=$3",
          [actor.workspaceId, actor.actorId, key],
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        if (old.operation === "delete")
          return {
            id: String(old.agenda_id),
            meetingId: command.meetingId,
            deleted: true as const,
            version: Number(old.agenda_version),
          };
        const current = (
          await db.query(
            "SELECT * FROM reviewed_agendas WHERE workspace_id=$1 AND id=$2 AND meeting_id=$3",
            [actor.workspaceId, old.agenda_id, command.meetingId],
          )
        ).rows[0];
        if (!current) throw new AppError("NOT_FOUND", 404);
        return dto(current);
      }
      if (Number(meeting.version) !== command.input.expectedMeetingVersion)
        throw new AppError("SOURCE_MEETING_CHANGED", 409);
      const agendaId = command.agendaId ?? randomUUID();
      let version = 1;
      let row: Record<string, unknown> | undefined;
      if (command.operation === "create") {
        const count = (
          await db.query(
            "SELECT count(*)::integer AS count FROM reviewed_agendas WHERE workspace_id=$1 AND meeting_id=$2",
            [actor.workspaceId, command.meetingId],
          )
        ).rows[0];
        if (Number(count.count) >= 100) throw new AppError("AGENDA_SCOPE_TOO_LARGE", 409);
        if (!("title" in command.input)) throw new AppError("INVALID_AGENDA", 400);
        row = (
          await db.query(
            "INSERT INTO reviewed_agendas(workspace_id,id,meeting_id,owner_id,title,body) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              actor.workspaceId,
              agendaId,
              command.meetingId,
              actor.actorId,
              command.input.title,
              command.input.body,
            ],
          )
        ).rows[0];
      } else {
        const current = (
          await db.query(
            "SELECT * FROM reviewed_agendas WHERE workspace_id=$1 AND id=$2 AND meeting_id=$3 FOR UPDATE",
            [actor.workspaceId, agendaId, command.meetingId],
          )
        ).rows[0];
        if (!current) throw new AppError("NOT_FOUND", 404);
        if (
          !("expectedVersion" in command.input) ||
          Number(current.version) !== command.input.expectedVersion
        )
          throw new AppError("VERSION_CONFLICT", 409);
        version = Number(current.version) + 1;
        if (command.operation === "delete")
          await db.query("DELETE FROM reviewed_agendas WHERE workspace_id=$1 AND id=$2", [
            actor.workspaceId,
            agendaId,
          ]);
        else {
          if (!("title" in command.input)) throw new AppError("INVALID_AGENDA", 400);
          row = (
            await db.query(
              "UPDATE reviewed_agendas SET title=$3,body=$4,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *",
              [actor.workspaceId, agendaId, command.input.title, command.input.body],
            )
          ).rows[0];
        }
      }
      const updated = (
        await db.query(
          "UPDATE meetings SET version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING version",
          [actor.workspaceId, command.meetingId],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO agenda_commands(workspace_id,actor_id,key,fingerprint,meeting_id,agenda_id,operation,agenda_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          actor.workspaceId,
          actor.actorId,
          key,
          fingerprint,
          command.meetingId,
          agendaId,
          command.operation,
          version,
        ],
      );
      const event = eventEnvelope.parse({
        eventId: randomUUID(),
        type: "meeting.updated.v1",
        schemaVersion: 1,
        workspaceId: actor.workspaceId,
        aggregateId: command.meetingId,
        aggregateVersion: Number(updated.version),
        occurredAt: new Date().toISOString(),
        traceId: randomBytes(16).toString("hex"),
        actorId: actor.actorId,
        references: [{ kind: "meeting", id: command.meetingId, revision: Number(updated.version) }],
      });
      await db.query("INSERT INTO outbox(workspace_id,id,event) VALUES($1,$2,$3::jsonb)", [
        actor.workspaceId,
        event.eventId,
        JSON.stringify(event),
      ]);
      await db.query(
        "INSERT INTO event_work_index(workspace_id,next_at) VALUES($1,now()) ON CONFLICT(workspace_id) DO UPDATE SET next_at=LEAST(event_work_index.next_at,excluded.next_at)",
        [actor.workspaceId],
      );
      return row
        ? dto(row)
        : { id: agendaId, meetingId: command.meetingId, deleted: true as const, version };
    });
  }
  snapshot(actor: Actor, meetingId: string, includeAccepted = true): Promise<AgendaSnapshot> {
    return this.scoped(actor, true, async (db) => {
      const meeting = await this.meeting(db, actor, id.parse(meetingId), false);
      const agendas = (
        await db.query(
          "SELECT * FROM reviewed_agendas WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY id LIMIT 101",
          [actor.workspaceId, meetingId],
        )
      ).rows;
      if (agendas.length > 100) throw new AppError("AGENDA_SCOPE_TOO_LARGE", 409);
      const accepted = includeAccepted
        ? (
            await db.query(
              "SELECT id,kind,version FROM (SELECT id,kind,version,row_number() OVER(PARTITION BY kind ORDER BY id) AS n FROM accepted_items WHERE workspace_id=$1 AND meeting_id=$2) a WHERE n<=101 ORDER BY kind,id",
              [actor.workspaceId, meetingId],
            )
          ).rows
        : [];
      if (
        ["decision", "commitment"].some(
          (kind) => accepted.filter((row) => row.kind === kind).length > 100,
        )
      )
        throw new AppError("REVIEW_SCOPE_TOO_LARGE", 409);
      return {
        meetingVersion: Number(meeting.version),
        agendas: agendas.map(dto),
        accepted: accepted.map((row) => ({
          id: String(row.id),
          kind: row.kind as "decision" | "commitment",
          version: Number(row.version),
        })),
      };
    });
  }
}
