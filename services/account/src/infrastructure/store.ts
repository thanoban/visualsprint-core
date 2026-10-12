import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { AppError, type Actor, type Identity } from "@visualsprint/platform";
import { eventEnvelope, id, type DomainEvent } from "@visualsprint/contracts";
import type {
  AccountRepository,
  AccountTransaction,
  AccountWorkspace,
} from "../application/ports.js";
import * as schema from "./schema.js";
const database = (pool: pg.Pool) => drizzle(pool, { schema });
type Database = ReturnType<typeof database>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
class AccountTx implements AccountTransaction {
  private workspaceId: string | undefined;
  constructor(
    private readonly db: Transaction,
    public readonly actorId: string,
  ) {}
  async setWorkspace(workspaceId: string) {
    id.parse(workspaceId);
    this.workspaceId = workspaceId;
    await this.db.execute(sql`SELECT set_config('app.workspace_id',${workspaceId},true)`);
  }
  workspaces() {
    return this.db
      .select({
        id: schema.workspaces.id,
        creatorId: schema.workspaces.creatorId,
        name: schema.workspaces.name,
        cellId: schema.workspaces.cellId,
        blocked: schema.workspaces.blocked,
      })
      .from(schema.workspaces)
      .innerJoin(
        schema.memberships,
        and(
          eq(schema.memberships.workspaceId, schema.workspaces.id),
          eq(schema.memberships.userId, this.actorId),
          eq(schema.memberships.active, true),
        ),
      )
      .where(eq(schema.workspaces.blocked, false))
      .orderBy(asc(schema.workspaces.id))
      .limit(100);
  }
  async workspace(workspaceId: string) {
    return (
      await this.db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1)
    )[0];
  }
  private scope() {
    if (!this.workspaceId) throw new Error("WORKSPACE_CONTEXT_REQUIRED");
    return this.workspaceId;
  }
  async membership(userId: string) {
    return (
      await this.db
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.workspaceId, this.scope()),
            eq(schema.memberships.userId, userId),
          ),
        )
        .limit(1)
    )[0];
  }
  members() {
    return this.db
      .select()
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.workspaceId, this.scope()), eq(schema.memberships.active, true)),
      )
      .orderBy(asc(schema.memberships.userId))
      .limit(100);
  }
  async sessionRevoked(sessionId: string) {
    return (
      (
        await this.db
          .select()
          .from(schema.revokedSessions)
          .where(
            and(
              eq(schema.revokedSessions.userId, this.actorId),
              eq(schema.revokedSessions.sessionId, sessionId),
            ),
          )
          .limit(1)
      ).length > 0
    );
  }
  async revokeSession(sessionId: string) {
    await this.db
      .insert(schema.revokedSessions)
      .values({ userId: this.actorId, sessionId })
      .onConflictDoNothing();
  }
  async addWorkspace(workspace: AccountWorkspace) {
    return (await this.db.insert(schema.workspaces).values(workspace).returning())[0]!;
  }
  async addOwner(workspaceId: string) {
    await this.db
      .insert(schema.memberships)
      .values({ workspaceId, userId: this.actorId, role: "owner", active: true, version: 1 });
  }
  async changeMembership(userId: string, active: boolean, expectedVersion: number) {
    if (expectedVersion === 0) {
      if (!active) throw new AppError("INVALID_MEMBERSHIP", 400);
      try {
        const row = (
          await this.db
            .insert(schema.memberships)
            .values({ workspaceId: this.scope(), userId, role: "member", active: true, version: 1 })
            .onConflictDoNothing()
            .returning()
        )[0];
        if (!row) throw new AppError("VERSION_CONFLICT", 409);
        return row;
      } catch (error) {
        if (
          error instanceof Error &&
          error.cause &&
          typeof error.cause === "object" &&
          "code" in error.cause &&
          error.cause.code === "23503"
        )
          throw new AppError("NOT_FOUND", 404);
        throw error;
      }
    }
    const row = (
      await this.db
        .update(schema.memberships)
        .set({ active, version: sql`${schema.memberships.version}+1` })
        .where(
          and(
            eq(schema.memberships.workspaceId, this.scope()),
            eq(schema.memberships.userId, userId),
            eq(schema.memberships.version, expectedVersion),
          ),
        )
        .returning()
    )[0];
    if (!row) throw new AppError("VERSION_CONFLICT", 409);
    return row;
  }
  async command<T>(key: string, fingerprint: string, work: () => Promise<T>): Promise<T> {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.actorId}:${key}`},0))`,
    );
    const old = (
      await this.db
        .select()
        .from(schema.commands)
        .where(and(eq(schema.commands.userId, this.actorId), eq(schema.commands.key, key)))
        .limit(1)
    )[0];
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      return old.response as T;
    }
    const result = await work();
    await this.db
      .insert(schema.commands)
      .values({ userId: this.actorId, key, fingerprint, response: result });
    return result;
  }
  async emit(event: DomainEvent) {
    eventEnvelope.parse(event);
    if (event.workspaceId !== this.scope()) throw new Error("TENANT_MISMATCH");
    await this.db
      .insert(schema.outbox)
      .values({ id: event.eventId, workspaceId: event.workspaceId, event });
  }
}
export class PostgresAccount implements AccountRepository {
  private readonly db: Database;
  constructor(pool: pg.Pool) {
    this.db = database(pool);
  }
  identity<T>(identity: Identity, work: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    if (!/^user_[A-Za-z0-9]+$/.test(identity.subject)) throw new AppError("UNAUTHENTICATED", 401);
    return this.db.transaction(async (db) => {
      await db.execute(sql`SELECT set_config('app.identity_subject',${identity.subject},true)`);
      await db
        .insert(schema.users)
        .values({ id: randomUUID(), subject: identity.subject })
        .onConflictDoNothing();
      const user = (
        await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.subject, identity.subject))
          .limit(1)
      )[0]!;
      await db.execute(sql`SELECT set_config('app.actor_id',${user.id},true)`);
      return work(new AccountTx(db, user.id));
    });
  }
  actor<T>(actor: Actor, work: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    id.parse(actor.actorId);
    id.parse(actor.workspaceId);
    return this.db.transaction(async (db) => {
      await db.execute(sql`SELECT set_config('app.actor_id',${actor.actorId},true)`);
      const tx = new AccountTx(db, actor.actorId);
      await tx.setWorkspace(actor.workspaceId);
      return work(tx);
    });
  }
}
