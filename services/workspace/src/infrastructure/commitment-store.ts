import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { AppError, type Actor } from "@visualsprint/platform";
import { eventEnvelope } from "@visualsprint/contracts";
import {
  acceptedFingerprint,
  acceptanceInput,
  correctionInput,
  type CommitmentStore,
  type AcceptedItem,
  type AcceptedKind,
  type EvidenceProof,
  type ProposalProof,
} from "../application/commitments.js";
const dbFor = (pool: pg.Pool) => drizzle(pool);
type Tx = Parameters<Parameters<ReturnType<typeof dbFor>["transaction"]>[0]>[0];
const decode = (r: Record<string, unknown>): AcceptedItem => ({
  workspaceId: String(r.workspace_id),
  id: String(r.id),
  meetingId: String(r.meeting_id),
  createdBy: String(r.created_by),
  reviewedBy: String(r.reviewed_by),
  kind: r.kind as AcceptedKind,
  title: String(r.title),
  text: String(r.body),
  ownerId: r.assignee_id as string | null,
  dueDate: r.due_date_value as string | null,
  state: r.state as AcceptedItem["state"],
  version: Number(r.version),
  sourceMeetingVersion: Number(r.source_meeting_version),
  citations: r.citations as EvidenceProof["citations"],
  sourceFingerprint: String(r.source_fingerprint),
  sourcePartial: r.source_partial === true,
  proposalRef: r.proposal_ref as AcceptedItem["proposalRef"],
  humanCorrected: r.human_corrected === true,
  statusSource: "human_review",
  createdAt: new Date(r.created_at as string).toISOString(),
  updatedAt: new Date(r.updated_at as string).toISOString(),
});
export class PostgresCommitments implements CommitmentStore {
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
  private async row(tx: Tx, itemId: string) {
    const row = (
      await tx.execute(
        sql`SELECT a.*,a.due_date::text AS due_date_value FROM accepted_items a JOIN meetings m ON m.workspace_id=a.workspace_id AND m.id=a.meeting_id WHERE a.id=${itemId} AND NOT m.blocked`,
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404);
    return decode(row);
  }
  private async replayTx(tx: Tx, actor: Actor, key: string, command: unknown) {
    const old = (
      await tx.execute(
        sql`SELECT fingerprint,item_id FROM accepted_commands WHERE actor_id=${actor.actorId} AND key=${key}`,
      )
    ).rows[0];
    if (!old) return;
    if (old.fingerprint !== acceptedFingerprint(command))
      throw new AppError("IDEMPOTENCY_CONFLICT", 409);
    return this.row(tx, String(old.item_id));
  }
  replay(actor: Actor, key: string, command: unknown) {
    return this.scoped(actor.workspaceId, (tx) => this.replayTx(tx, actor, key, command));
  }
  private command(
    actor: Actor,
    key: string,
    command: unknown,
    work: (tx: Tx) => Promise<AcceptedItem>,
  ) {
    return this.scoped(actor.workspaceId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.workspaceId + ":accepted-command:" + actor.actorId + ":" + key},0))`,
      );
      const old = await this.replayTx(tx, actor, key, command);
      if (old) return old;
      const item = await work(tx);
      await tx.execute(
        sql`INSERT INTO accepted_commands(workspace_id,actor_id,key,fingerprint,item_id) VALUES(${actor.workspaceId},${actor.actorId},${key},${acceptedFingerprint(command)},${item.id})`,
      );
      await this.emit(tx, actor, item);
      return item;
    });
  }
  private async owner(tx: Tx, actor: Actor, meetingId: string, expectedVersion?: number) {
    const row = (
      await tx.execute(
        sql`SELECT owner_id,version,blocked FROM meetings WHERE id=${meetingId} FOR UPDATE`,
      )
    ).rows[0];
    if (!row || row.blocked || row.owner_id !== actor.actorId) throw new AppError("NOT_FOUND", 404);
    if (expectedVersion !== undefined && Number(row.version) !== expectedVersion)
      throw new AppError("SOURCE_MEETING_CHANGED", 409);
  }
  private async emit(tx: Tx, actor: Actor, item: AcceptedItem) {
    const event = eventEnvelope.parse({
      eventId: randomUUID(),
      type: "proposal.confirmed.v1",
      schemaVersion: 1,
      workspaceId: actor.workspaceId,
      aggregateId: item.id,
      aggregateVersion: item.version,
      occurredAt: new Date().toISOString(),
      traceId: randomBytes(16).toString("hex"),
      actorId: actor.actorId,
      references: [
        { kind: "meeting", id: item.meetingId, revision: item.sourceMeetingVersion },
        { kind: "proposal", id: item.id, revision: item.version },
      ],
    });
    await tx.execute(
      sql`INSERT INTO outbox(workspace_id,id,event) VALUES(${actor.workspaceId},${event.eventId},${JSON.stringify(event)}::jsonb)`,
    );
    await tx.execute(
      sql`INSERT INTO event_work_index(workspace_id,next_at) VALUES(${actor.workspaceId},now()) ON CONFLICT(workspace_id) DO UPDATE SET next_at=LEAST(event_work_index.next_at,excluded.next_at)`,
    );
  }
  accept(
    actor: Actor,
    key: string,
    input: z.infer<typeof acceptanceInput>,
    kind: AcceptedKind,
    proof: EvidenceProof,
    proposal: ProposalProof | null,
  ) {
    return this.command(actor, key, { type: "accept", kind, input }, async (tx) => {
      await this.owner(tx, actor, input.meetingId, input.expectedMeetingVersion);
      if (
        proposal &&
        (
          await tx.execute(
            sql`SELECT 1 FROM accepted_items WHERE meeting_id=${input.meetingId} AND kind=${kind} AND proposal_ref->>'jobId'=${proposal.jobId} AND (proposal_ref->>'claimIndex')::int=${proposal.claimIndex}`,
          )
        ).rows.length
      )
        throw new AppError("PROPOSAL_ALREADY_REVIEWED", 409);
      const itemId = randomUUID(),
        ref = proposal
          ? {
              jobId: proposal.jobId,
              claimIndex: proposal.claimIndex,
              kind: proposal.kind,
              textHash: acceptedFingerprint(proposal.text),
            }
          : null;
      await tx.execute(
        sql`INSERT INTO accepted_items(workspace_id,id,meeting_id,created_by,reviewed_by,kind,title,body,assignee_id,due_date,state,source_meeting_version,citations,source_fingerprint,source_partial,proposal_ref,human_corrected) VALUES(${actor.workspaceId},${itemId},${input.meetingId},${actor.actorId},${actor.actorId},${kind},${input.content.title},${input.content.text},${input.content.ownerId},${input.content.dueDate},${kind === "decision" ? "accepted" : "open"},${input.expectedMeetingVersion},${JSON.stringify(proof.citations)}::jsonb,${proof.fingerprint},${proof.partial},${JSON.stringify(ref)}::jsonb,${proposal ? proposal.text !== input.content.text || proposal.kind !== kind : true})`,
      );
      return this.row(tx, itemId);
    });
  }
  get(ws: string, itemId: string) {
    return this.scoped(ws, async (tx) => {
      const row = (
        await tx.execute(
          sql`SELECT a.*,a.due_date::text AS due_date_value FROM accepted_items a JOIN meetings m ON m.workspace_id=a.workspace_id AND m.id=a.meeting_id WHERE a.id=${itemId} AND NOT m.blocked`,
        )
      ).rows[0];
      return row ? decode(row) : undefined;
    });
  }
  list(ws: string, meetingIds: string[], kind: AcceptedKind, limit: 100 | 101 = 100) {
    if (!meetingIds.length) return Promise.resolve([]);
    return this.scoped(ws, async (tx) =>
      (
        await tx.execute(
          sql`SELECT a.*,a.due_date::text AS due_date_value FROM accepted_items a JOIN meetings m ON m.workspace_id=a.workspace_id AND m.id=a.meeting_id WHERE a.meeting_id IN(${sql.join(
            meetingIds.map((v) => sql`${v}::uuid`),
            sql`,`,
          )}) AND a.kind=${kind} AND NOT m.blocked ORDER BY a.id LIMIT ${limit}`,
        )
      ).rows.map(decode),
    );
  }
  correct(
    actor: Actor,
    key: string,
    item: AcceptedItem,
    input: z.infer<typeof correctionInput>,
    proof: EvidenceProof,
  ) {
    return this.command(
      actor,
      key,
      { type: "correct", itemId: item.id, kind: item.kind, input },
      async (tx) => {
        await this.owner(tx, actor, item.meetingId, input.expectedMeetingVersion);
        const row = (
          await tx.execute(
            sql`UPDATE accepted_items SET title=${input.content.title},body=${input.content.text},assignee_id=${input.content.ownerId},due_date=${input.content.dueDate},source_meeting_version=${input.expectedMeetingVersion},citations=${JSON.stringify(proof.citations)}::jsonb,source_fingerprint=${proof.fingerprint},source_partial=${proof.partial},reviewed_by=${actor.actorId},human_corrected=true,version=version+1,updated_at=now() WHERE id=${item.id} AND version=${input.expectedVersion} RETURNING id`,
          )
        ).rows[0];
        if (!row) throw new AppError("VERSION_CONFLICT", 409);
        return this.row(tx, item.id);
      },
    );
  }
  status(
    actor: Actor,
    key: string,
    item: AcceptedItem,
    input: { expectedVersion: number; state: AcceptedItem["state"]; confirmed: true },
  ) {
    return this.command(
      actor,
      key,
      { type: "status", itemId: item.id, kind: item.kind, input },
      async (tx) => {
        await this.owner(tx, actor, item.meetingId);
        const row = (
          await tx.execute(
            sql`UPDATE accepted_items SET state=${input.state},reviewed_by=${actor.actorId},version=version+1,updated_at=now() WHERE id=${item.id} AND version=${input.expectedVersion} RETURNING id`,
          )
        ).rows[0];
        if (!row) throw new AppError("VERSION_CONFLICT", 409);
        return this.row(tx, item.id);
      },
    );
  }
}
