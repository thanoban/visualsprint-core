import { randomUUID, createHash } from "node:crypto";
import { and, asc, eq, exists, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { eventEnvelope, id, type DomainEvent, type CalendarMeeting } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type {
  Customer,
  Project,
  Meeting,
  WorkspaceRepository,
  WorkspaceTransaction,
  EventPublisher,
} from "../application/ports.js";
import * as schema from "./schema.js";

const makeDb = (pool: pg.Pool) => drizzle(pool, { schema });
type Database = ReturnType<typeof makeDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

class TransactionRepository implements WorkspaceTransaction {
  constructor(
    private readonly db: Transaction,
    private readonly actor: Actor,
  ) {}
  async upsertCalendar(input: CalendarMeeting) {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.actor.workspaceId + ":calendar:" + input.connectionId + ":" + input.occurrenceId},0))`,
    );
    const condition = and(
      eq(schema.calendarMeetings.workspaceId, this.actor.workspaceId),
      eq(schema.calendarMeetings.connectionId, input.connectionId),
      eq(schema.calendarMeetings.occurrenceId, input.occurrenceId),
    );
    const old = (
      await this.db.select().from(schema.calendarMeetings).where(condition).for("update")
    )[0];
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    if (old && old.ownerId !== this.actor.actorId) throw new AppError("NOT_FOUND", 404);
    let meeting = old
      ? (
          await this.db
            .select()
            .from(schema.meetings)
            .where(
              and(
                eq(schema.meetings.id, old.meetingId),
                eq(schema.meetings.ownerId, this.actor.actorId),
                eq(schema.meetings.blocked, false),
              ),
            )
            .for("update")
        )[0]
      : undefined;
    if (old && (!meeting || meeting.ownerId !== this.actor.actorId))
      throw new AppError("NOT_FOUND", 404);
    if (old && input.sourceVersion <= old.sourceVersion) {
      if (input.sourceVersion === old.sourceVersion && fingerprint !== old.fingerprint)
        throw new AppError("SOURCE_REVISION_CONFLICT", 409);
      return { meeting: meeting!, changed: false };
    }
    if (!old && (input.status === "cancelled" || input.allDay || input.declined))
      throw new AppError("OCCURRENCE_NOT_ELIGIBLE", 409);
    const title = input.title.slice(0, 200);
    if (!meeting)
      meeting = await this.createMeeting({
        id: randomUUID(),
        workspaceId: this.actor.workspaceId,
        ownerId: this.actor.actorId,
        title,
        notes: "",
        joinUrl: input.joinUrl,
        version: 1,
        blocked: false,
      });
    else
      meeting = (
        await this.db
          .update(schema.meetings)
          .set({
            title: meeting.title === old!.lastTitle ? title : meeting.title,
            joinUrl: input.joinUrl,
            version: sql`${schema.meetings.version}+1`,
          })
          .where(
            and(
              eq(schema.meetings.id, meeting.id),
              eq(schema.meetings.ownerId, this.actor.actorId),
              eq(schema.meetings.blocked, false),
            ),
          )
          .returning()
      )[0]!;
    const projection = {
      workspaceId: this.actor.workspaceId,
      connectionId: input.connectionId,
      occurrenceId: input.occurrenceId,
      meetingId: meeting.id,
      ownerId: this.actor.actorId,
      sourceVersion: input.sourceVersion,
      fingerprint,
      lastTitle: title,
      status: input.status,
      allDay: input.allDay,
      declined: input.declined,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
    };
    await this.db
      .insert(schema.calendarMeetings)
      .values(projection)
      .onConflictDoUpdate({
        target: [
          schema.calendarMeetings.workspaceId,
          schema.calendarMeetings.connectionId,
          schema.calendarMeetings.occurrenceId,
        ],
        set: projection,
      });
    return { meeting, changed: true };
  }
  async calendarCaptureAllowed(meetingId: string) {
    const row = (
      await this.db
        .select()
        .from(schema.calendarMeetings)
        .where(eq(schema.calendarMeetings.meetingId, meetingId))
        .limit(1)
    )[0];
    return !row || (row.status !== "cancelled" && !row.allDay && !row.declined);
  }
  async customer(customerId: string) {
    return (
      await this.db
        .select()
        .from(schema.customers)
        .where(
          and(
            eq(schema.customers.id, customerId),
            eq(schema.customers.ownerId, this.actor.actorId),
          ),
        )
        .limit(1)
    )[0];
  }
  async project(projectId: string) {
    return (
      await this.db
        .select()
        .from(schema.projects)
        .where(
          and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, this.actor.actorId)),
        )
        .limit(1)
    )[0];
  }
  private visibleMeeting() {
    return and(
      eq(schema.meetings.blocked, false),
      or(
        eq(schema.meetings.ownerId, this.actor.actorId),
        exists(
          this.db
            .select({ id: schema.readers.userId })
            .from(schema.readers)
            .where(
              and(
                eq(schema.readers.workspaceId, schema.meetings.workspaceId),
                eq(schema.readers.meetingId, schema.meetings.id),
                eq(schema.readers.userId, this.actor.actorId),
              ),
            ),
        ),
      ),
    );
  }
  async meeting(meetingId: string) {
    return (
      await this.db
        .select()
        .from(schema.meetings)
        .where(and(eq(schema.meetings.id, meetingId), this.visibleMeeting()))
        .limit(1)
    )[0];
  }
  async meetingAccess(meetingId: string) {
    const record = (
      await this.db
        .select({ ownerId: schema.meetings.ownerId, blocked: schema.meetings.blocked })
        .from(schema.meetings)
        .where(eq(schema.meetings.id, meetingId))
        .limit(1)
    )[0];
    if (!record) return undefined;
    const readers = await this.db
      .select({ userId: schema.readers.userId })
      .from(schema.readers)
      .where(eq(schema.readers.meetingId, meetingId));
    return { ...record, readerIds: readers.map((row) => row.userId) };
  }
  listCustomers() {
    return this.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.ownerId, this.actor.actorId))
      .orderBy(asc(schema.customers.id))
      .limit(100);
  }
  listProjects() {
    return this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, this.actor.actorId))
      .orderBy(asc(schema.projects.id))
      .limit(100);
  }
  listMeetings(projectId?: string) {
    const assigned = projectId
      ? exists(
          this.db
            .select({ id: schema.assignments.projectId })
            .from(schema.assignments)
            .where(
              and(
                eq(schema.assignments.meetingId, schema.meetings.id),
                eq(schema.assignments.projectId, projectId),
              ),
            ),
        )
      : undefined;
    return this.db
      .select()
      .from(schema.meetings)
      .where(and(this.visibleMeeting(), assigned))
      .orderBy(asc(schema.meetings.id))
      .limit(100);
  }
  async createCustomer(record: Customer) {
    return (await this.db.insert(schema.customers).values(record).returning())[0]!;
  }
  async createProject(record: Project) {
    return (await this.db.insert(schema.projects).values(record).returning())[0]!;
  }
  async createMeeting(record: Omit<Meeting, "createdAt">) {
    return (await this.db.insert(schema.meetings).values(record).returning())[0]!;
  }
  async updateMeeting(
    meetingId: string,
    expectedVersion: number,
    changes: { title?: string; notes?: string },
  ) {
    const record = (
      await this.db
        .update(schema.meetings)
        .set({ ...changes, version: sql`${schema.meetings.version}+1` })
        .where(
          and(
            eq(schema.meetings.id, meetingId),
            eq(schema.meetings.ownerId, this.actor.actorId),
            eq(schema.meetings.version, expectedVersion),
            eq(schema.meetings.blocked, false),
          ),
        )
        .returning()
    )[0];
    if (!record) throw new AppError("VERSION_CONFLICT", 409);
    return record;
  }
  async assign(meetingId: string, projectId: string, actorId: string) {
    await this.db
      .insert(schema.assignments)
      .values({ workspaceId: this.actor.workspaceId, meetingId, projectId, confirmedBy: actorId })
      .onConflictDoNothing();
  }
  async share(meetingId: string, userId: string) {
    await this.db
      .insert(schema.readers)
      .values({ workspaceId: this.actor.workspaceId, meetingId, userId })
      .onConflictDoNothing();
  }
  async unshare(meetingId: string, userId: string) {
    await this.db
      .delete(schema.readers)
      .where(and(eq(schema.readers.meetingId, meetingId), eq(schema.readers.userId, userId)));
  }
  async emit(event: DomainEvent) {
    eventEnvelope.parse(event);
    if (event.workspaceId !== this.actor.workspaceId) throw new AppError("TENANT_MISMATCH", 403);
    await this.db
      .insert(schema.outbox)
      .values({ workspaceId: event.workspaceId, id: event.eventId, event });
  }
}

export class PostgresWorkspace implements WorkspaceRepository {
  private readonly db: Database;
  constructor(pool: pg.Pool) {
    this.db = makeDb(pool);
  }
  private tenant<T>(workspaceId: string, work: (tx: Transaction) => Promise<T>) {
    id.parse(workspaceId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id',${workspaceId},true)`);
      return work(tx);
    });
  }
  read<T>(actor: Actor, work: (tx: WorkspaceTransaction) => Promise<T>) {
    return this.tenant(actor.workspaceId, (tx) => work(new TransactionRepository(tx, actor)));
  }
  command<T>(
    actor: Actor,
    key: string,
    fingerprint: string,
    work: (tx: WorkspaceTransaction) => Promise<T>,
    guard?: (tx: WorkspaceTransaction) => Promise<void>,
  ) {
    return this.tenant(actor.workspaceId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.workspaceId}:${actor.actorId}:${key}`},0))`,
      );
      const repository = new TransactionRepository(tx, actor);
      // Recheck current ACL/deletion barriers even when returning an idempotent replay.
      if (guard) await guard(repository);
      const old = (
        await tx
          .select()
          .from(schema.commands)
          .where(and(eq(schema.commands.actorId, actor.actorId), eq(schema.commands.key, key)))
          .limit(1)
      )[0];
      if (old) {
        if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        return old.response as T;
      }
      const result = await work(repository);
      await tx.insert(schema.commands).values({
        workspaceId: actor.workspaceId,
        actorId: actor.actorId,
        key,
        fingerprint,
        response: result,
      });
      return result;
    });
  }
  async publish(workspaceId: string, publisher: EventPublisher, limit = 20): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("INVALID_BATCH_LIMIT");
    const token = randomUUID();
    const claimed = await this.tenant(workspaceId, async (tx) => {
      const result = await tx.execute<{ id: string; event: DomainEvent }>(sql`
        WITH candidates AS (SELECT id FROM outbox WHERE published_at IS NULL
          AND (lease_until IS NULL OR lease_until < now()) ORDER BY created_at,id
          LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        UPDATE outbox SET lease_token=${token}::uuid, lease_until=now()+interval '30 seconds', attempts=attempts+1
        FROM candidates WHERE outbox.id=candidates.id RETURNING outbox.id,outbox.event`);
      return result.rows;
    });
    let published = 0;
    for (const row of claimed) {
      await publisher.publish(eventEnvelope.parse(row.event));
      const updated = await this.tenant(workspaceId, (tx) =>
        tx
          .update(schema.outbox)
          .set({ publishedAt: new Date(), leaseUntil: null, leaseToken: null })
          .where(
            and(
              eq(schema.outbox.id, row.id),
              eq(schema.outbox.leaseToken, token),
              isNull(schema.outbox.publishedAt),
            ),
          )
          .returning({ id: schema.outbox.id }),
      );
      published += updated.length;
    }
    return published;
  }
  async eventWorkspaces() {
    const result = await this.db.execute(
      sql`SELECT workspace_id AS id FROM event_work_index WHERE next_at<=now() ORDER BY next_at,workspace_id LIMIT 20`,
    );
    return result.rows.map((row) => id.parse(row.id));
  }
  async deferEvents(workspaceId: string, seconds: number) {
    id.parse(workspaceId);
    await this.db.execute(
      sql`UPDATE event_work_index SET next_at=now()+${seconds}*interval '1 second' WHERE workspace_id=${workspaceId}`,
    );
  }
  consume<T>(
    event: DomainEvent,
    work: (tx: WorkspaceTransaction) => Promise<T>,
  ): Promise<{ duplicate: boolean; result?: T }> {
    const parsed = eventEnvelope.parse(event);
    if (!parsed.actorId) throw new Error("ACTOR_REQUIRED_FOR_WORKSPACE_MUTATION");
    return this.tenant(parsed.workspaceId, async (tx) => {
      const inserted = await tx
        .insert(schema.inbox)
        .values({ workspaceId: parsed.workspaceId, eventId: parsed.eventId })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) return { duplicate: true };
      const result = await work(
        new TransactionRepository(tx, {
          workspaceId: parsed.workspaceId,
          actorId: parsed.actorId!,
          sessionId: "event-consumer",
        }),
      );
      return { duplicate: false, result };
    });
  }
}
