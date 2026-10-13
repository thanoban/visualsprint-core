import { createHash, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { id, calendarMeeting } from "@visualsprint/contracts";
import { AppError, type Actor } from "@visualsprint/platform";
import type { CalendarCaptureOrchestrator } from "./calendar-captures.js";
import type { Connection, Tokens } from "../domain/records.js";
import type {
  ConnectionRepository,
  CalendarAuthority,
  CalendarProviders,
  TokenVault,
  ConnectionTx,
  CalendarMeetings,
} from "./ports.js";
const keySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const startInput = z.object({ provider: z.enum(["google", "microsoft"]) }).strict();
const oauthInput = z
  .object({
    connectionId: id,
    state: z
      .string()
      .min(32)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/),
    code: z.string().min(1).max(16000),
  })
  .strict();
const secrets = z.object({ state: z.string(), verifier: z.string() }).strict();
const tokenRecord = z
  .object({
    accessToken: z.string().min(1).max(16000),
    refreshToken: z.string().min(1).max(16000),
    expiresAt: z.string().datetime(),
  })
  .strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secretContext = (record: Pick<Connection, "workspaceId" | "id">, kind: "oauth" | "tokens") =>
  `${record.workspaceId}:${record.id}:${kind}:v1`;
export function connectionView(record: Connection) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    provider: record.provider,
    status: record.status,
    calendarId: record.calendarId,
    calendarName: record.calendarName,
    version: record.version,
    automatic: record.automatic,
    errorCode: record.errorCode,
    cleanupPending: !record.automatic && record.grantId !== null,
  };
}
export class CalendarService {
  automaticCaptureConfigured() {
    return Boolean(this.captures && this.meetings);
  }
  constructor(
    private readonly repository: ConnectionRepository,
    private readonly authority: CalendarAuthority,
    private readonly providers: CalendarProviders,
    private readonly vault: TokenVault,
    private readonly now: () => Date = () => new Date(),
    private readonly meetings?: CalendarMeetings,
    private readonly captures?: CalendarCaptureOrchestrator,
  ) {}
  private provider(name: Connection["provider"]) {
    const provider = this.providers[name];
    if (!provider) throw new AppError("CALENDAR_NOT_CONFIGURED", 503);
    return provider;
  }
  private async authorize(actor: Actor) {
    if (actor.operationGrantId) throw new AppError("FORBIDDEN", 403);
    await this.authority.requireActive(actor);
  }
  private async owned(tx: ConnectionTx, actor: Actor, connectionId: string) {
    const record = await tx.get(id.parse(connectionId));
    if (!record || record.ownerId !== actor.actorId) throw new AppError("NOT_FOUND", 404);
    return record;
  }
  async list(actor: Actor) {
    await this.authorize(actor);
    return (await this.repository.scoped(actor.workspaceId, (tx) => tx.list(actor.actorId))).map(
      connectionView,
    );
  }
  async start(actor: Actor, key: string, body: unknown) {
    await this.authorize(actor);
    keySchema.parse(key);
    const input = startInput.parse(body);
    const provider = this.provider(input.provider);
    const record = await this.repository.scoped(actor.workspaceId, (tx) =>
      tx.command(actor, key, hash(JSON.stringify(["oauth.start", input])), async () => {
        const connectionId = randomUUID(),
          state = randomBytes(32).toString("base64url"),
          verifier = randomBytes(32).toString("base64url");
        const record: Connection = {
          workspaceId: actor.workspaceId,
          id: connectionId,
          ownerId: actor.actorId,
          sessionId: actor.sessionId,
          provider: input.provider,
          status: "authorizing",
          calendarId: "primary",
          calendarName: "Calendar",
          version: 1,
          oauthHash: hash(state),
          oauthCipher: this.vault.seal(
            { state, verifier },
            secretContext({ workspaceId: actor.workspaceId, id: connectionId }, "oauth"),
          ),
          oauthExpiresAt: new Date(this.now().getTime() + 600000),
          tokenCipher: null,
          tokenExpiresAt: null,
          exchangeAt: null,
          errorCode: null,
          grantId: null,
          automatic: false,
          leaseToken: null,
          leaseUntil: null,
          createdAt: this.now(),
        };
        const created = await tx.create(record);
        await tx.emit(created);
        return created;
      }),
    );
    if (record.sessionId !== actor.sessionId) throw new AppError("OAUTH_SESSION_CHANGED", 409);
    if (
      record.status !== "authorizing" ||
      !record.oauthCipher ||
      record.oauthExpiresAt <= this.now()
    )
      return { connection: connectionView(record), authorizationUrl: null, expiresAt: null };
    const secret = secrets.parse(
      this.vault.open(record.oauthCipher, secretContext(record, "oauth")),
    );
    const challenge = createHash("sha256").update(secret.verifier).digest("base64url");
    return {
      connection: connectionView(record),
      authorizationUrl: provider.authorizationUrl(secret.state, challenge),
      expiresAt: record.oauthExpiresAt.toISOString(),
    };
  }
  async finish(actor: Actor, body: unknown) {
    await this.authorize(actor);
    const input = oauthInput.parse(body);
    const claim = await this.repository.scoped(actor.workspaceId, async (tx) => {
      const record = await this.owned(tx, actor, input.connectionId);
      if (
        record.sessionId !== actor.sessionId ||
        !timingSafeEqual(
          Buffer.from(record.oauthHash, "hex"),
          Buffer.from(hash(input.state), "hex"),
        )
      )
        throw new AppError("INVALID_OAUTH_STATE", 403);
      if (["initializing", "connected"].includes(record.status)) return { record, verifier: null };
      if (record.status !== "authorizing") throw new AppError("OAUTH_EXCHANGE_UNKNOWN", 409);
      if (record.oauthExpiresAt <= this.now() || !record.oauthCipher)
        throw new AppError("OAUTH_STATE_EXPIRED", 409);
      const secret = secrets.parse(
        this.vault.open(record.oauthCipher, secretContext(record, "oauth")),
      );
      const updated = await tx.update(record.id, { status: "exchanging", exchangeAt: this.now() });
      await tx.emit(updated);
      return { record: updated, verifier: secret.verifier };
    });
    if (claim.verifier === null) return connectionView(claim.record);
    let tokens: Tokens;
    try {
      tokens = await this.provider(claim.record.provider).exchange(input.code, claim.verifier);
    } catch (error) {
      await this.repository.scoped(actor.workspaceId, async (tx) => {
        const current = await tx.get(claim.record.id);
        if (current?.status === "exchanging") {
          const known = error instanceof AppError ? error.code : "OAUTH_RESPONSE_UNKNOWN";
          const updated = await tx.update(current.id, {
            status:
              known === "REAUTH_REQUIRED" || known === "OFFLINE_ACCESS_REQUIRED"
                ? "reauth_required"
                : known === "CALENDAR_CONFIGURATION" || known === "CALENDAR_SCOPE_MISSING"
                  ? "configuration_error"
                  : "exchange_unknown",
            errorCode: known,
            oauthCipher: null,
          });
          await tx.emit(updated);
        }
      });
      throw error;
    }
    return this.repository.scoped(actor.workspaceId, async (tx) => {
      const current = await tx.get(claim.record.id);
      if (!current || current.status !== "exchanging")
        throw new AppError("OAUTH_STATE_CHANGED", 409);
      const updated = await tx.update(current.id, {
        status: "initializing",
        tokenCipher: this.sealTokens(current, tokens),
        tokenExpiresAt: tokens.expiresAt,
        oauthCipher: null,
        errorCode: null,
      });
      await tx.emit(updated);
      return connectionView(updated);
    });
  }
  private sealTokens(record: Connection, tokens: Tokens) {
    const data = tokenRecord.parse({ ...tokens, expiresAt: tokens.expiresAt.toISOString() });
    return this.vault.seal(data, secretContext(record, "tokens"));
  }
  private tokens(record: Connection): Tokens {
    if (!record.tokenCipher) throw new AppError("CONNECTION_UNAVAILABLE", 409);
    const value = tokenRecord.parse(
      this.vault.open(record.tokenCipher, secretContext(record, "tokens")),
    );
    return { ...value, expiresAt: new Date(value.expiresAt) };
  }
  private async withTokens<T>(
    actor: Actor,
    connectionId: string,
    work: (record: Connection, accessToken: string) => Promise<T>,
  ): Promise<T> {
    if (actor.operationGrantId) {
      const grant = await this.authority.operation(actor);
      if (grant.connectionId !== connectionId) throw new AppError("FORBIDDEN", 403);
    } else await this.authorize(actor);
    const leaseToken = randomUUID();
    const record = await this.repository.scoped(actor.workspaceId, async (tx) => {
      const current = await this.owned(tx, actor, connectionId);
      if (
        actor.operationGrantId &&
        (!current.automatic || current.grantId !== actor.operationGrantId)
      )
        throw new AppError("FORBIDDEN", 403);
      if (!["initializing", "connected"].includes(current.status))
        throw new AppError("CONNECTION_UNAVAILABLE", 409);
      if (current.leaseUntil && current.leaseUntil > this.now())
        throw new AppError("CONNECTION_BUSY", 503);
      return tx.update(current.id, {
        leaseToken,
        leaseUntil: new Date(this.now().getTime() + 30000),
      });
    });
    try {
      let tokens = this.tokens(record);
      if (tokens.expiresAt.getTime() <= this.now().getTime() + 60000) {
        tokens = await this.provider(record.provider).refresh(tokens.refreshToken);
        await this.repository.scoped(actor.workspaceId, async (tx) => {
          const current = await this.owned(tx, actor, connectionId);
          if (current.leaseToken !== leaseToken || current.status === "disconnected")
            throw new AppError("CONNECTION_UNAVAILABLE", 409);
          await tx.update(current.id, {
            tokenCipher: this.sealTokens(current, tokens),
            tokenExpiresAt: tokens.expiresAt,
          });
        });
      }
      const result = await work(record, tokens.accessToken);
      await this.authority.requireActive(actor);
      await this.repository.scoped(actor.workspaceId, async (tx) => {
        const current = await this.owned(tx, actor, connectionId);
        if (current.leaseToken !== leaseToken || current.status === "disconnected")
          throw new AppError("CONNECTION_UNAVAILABLE", 409);
      });
      return result;
    } catch (error) {
      if (
        error instanceof AppError &&
        ["REAUTH_REQUIRED", "CALENDAR_CONFIGURATION"].includes(error.code)
      )
        await this.repository.scoped(actor.workspaceId, async (tx) => {
          const current = await tx.get(connectionId);
          if (current?.leaseToken === leaseToken && current.status !== "disconnected") {
            const updated = await tx.update(current.id, {
              status: error.code === "REAUTH_REQUIRED" ? "reauth_required" : "configuration_error",
              errorCode: error.code,
              automatic: false,
            });
            await tx.emit(updated);
          }
        });
      throw error;
    } finally {
      await this.repository.scoped(actor.workspaceId, async (tx) => {
        const current = await tx.get(connectionId);
        if (current?.leaseToken === leaseToken)
          await tx.update(current.id, { leaseToken: null, leaseUntil: null });
      });
    }
  }
  async initialize(actor: Actor, connectionId: string) {
    return this.withTokens(actor, connectionId, async (record, token) => {
      if (record.status === "connected") return connectionView(record);
      const calendar = await this.provider(record.provider).resolveCalendar(
        token,
        record.calendarId,
      );
      await this.authority.requireActive(actor);
      return this.repository.scoped(actor.workspaceId, async (tx) => {
        const current = await this.owned(tx, actor, connectionId);
        if (current.status !== "initializing" || current.leaseToken !== record.leaseToken)
          throw new AppError("CONNECTION_UNAVAILABLE", 409);
        const updated = await tx.update(current.id, {
          status: "connected",
          calendarId: calendar.id,
          calendarName: calendar.name,
          errorCode: null,
        });
        await tx.emit(updated);
        return connectionView(updated);
      });
    });
  }
  async calendars(actor: Actor, connectionId: string, cursor?: string) {
    return this.withTokens(actor, connectionId, (record, token) =>
      this.provider(record.provider).calendars(token, cursor),
    );
  }
  async occurrences(actor: Actor, connectionId: string, query: unknown) {
    const input = z
      .object({
        startsAt: z.string().datetime().optional(),
        endsAt: z.string().datetime().optional(),
        cursor: z.string().min(1).max(16000).optional(),
      })
      .strict()
      .parse(query);
    if (Boolean(input.startsAt) !== Boolean(input.endsAt) || (input.cursor && !input.startsAt))
      throw new AppError("INVALID_CALENDAR_WINDOW", 400);
    const startsAt = input.startsAt ?? this.now().toISOString();
    const endsAt = input.endsAt ?? new Date(Date.parse(startsAt) + 14 * 86400000).toISOString();
    if (
      Date.parse(endsAt) <= Date.parse(startsAt) ||
      Date.parse(endsAt) - Date.parse(startsAt) > 14 * 86400000 ||
      Math.abs(Date.parse(startsAt) - this.now().getTime()) > 30 * 86400000
    )
      throw new AppError("INVALID_CALENDAR_WINDOW", 400);
    return this.withTokens(actor, connectionId, async (record, token) => {
      if (record.status !== "connected") throw new AppError("CONNECTION_UNAVAILABLE", 409);
      const window = { startsAt, endsAt };
      return {
        window,
        ...(await this.provider(record.provider).occurrences(
          token,
          record.calendarId,
          window,
          input.cursor,
        )),
      };
    });
  }
  async synchronize(actor: Actor, connectionId: string, key: string) {
    await this.authorize(actor);
    keySchema.parse(key);
    return this.repository.scoped(actor.workspaceId, async (tx) => {
      const record = await this.owned(tx, actor, connectionId);
      if (record.status !== "connected") throw new AppError("CONNECTION_UNAVAILABLE", 409);
      return this.syncView(await tx.queueSync(actor, key, record, this.now()));
    });
  }
  async automation(actor: Actor, connectionId: string, key: string, body: unknown) {
    await this.authorize(actor);
    keySchema.parse(key);
    const input = z
      .discriminatedUnion("enabled", [
        z
          .object({
            enabled: z.literal(true),
            grantId: id,
            consent: z.literal(true),
            expectedVersion: z.number().int().positive(),
          })
          .strict(),
        z
          .object({ enabled: z.literal(false), expectedVersion: z.number().int().positive() })
          .strict(),
      ])
      .parse(body);
    if (input.enabled) {
      const principal = {
        ...actor,
        sessionId: `operation:${input.grantId}`,
        operationGrantId: input.grantId,
      };
      const grant = await this.authority.operation(principal);
      if (grant.connectionId !== connectionId) throw new AppError("FORBIDDEN", 403);
    }
    const result = await this.repository.scoped(actor.workspaceId, (tx) =>
      tx.command(
        actor,
        key,
        hash(JSON.stringify(["calendar.automation", connectionId, input])),
        async () => {
          const record = await this.owned(tx, actor, connectionId);
          if (record.version !== input.expectedVersion) throw new AppError("VERSION_CONFLICT", 409);
          if (input.enabled && record.status !== "connected")
            throw new AppError("CONNECTION_UNAVAILABLE", 409);
          if (
            input.enabled &&
            record.grantId &&
            (record.grantId !== input.grantId || !record.automatic)
          )
            throw new AppError("DISABLE_AUTOMATION_FIRST", 409);
          const updated = await tx.update(record.id, {
            automatic: input.enabled,
            ...(input.enabled ? { grantId: input.grantId } : {}),
            errorCode: null,
          });
          const pending = await tx.latestSync(record.id, true);
          if (pending) await tx.endSync(pending, "superseded", "POLICY_CHANGED");
          await tx.emit(updated);
          return updated;
        },
      ),
    );
    return connectionView(result);
  }
  private syncView(job: import("../domain/sync.js").CalendarSync) {
    return {
      id: job.id,
      state: job.state,
      pageCount: job.pageCount,
      errorCode: job.errorCode,
      window: { startsAt: job.startsAt.toISOString(), endsAt: job.endsAt.toISOString() },
    };
  }
  async syncStatus(actor: Actor, connectionId: string) {
    await this.authorize(actor);
    return this.repository.scoped(actor.workspaceId, async (tx) => {
      await this.owned(tx, actor, connectionId);
      const job = await tx.latestSync(connectionId);
      return job ? this.syncView(job) : null;
    });
  }
  async storedOccurrences(actor: Actor, connectionId: string, after?: string) {
    await this.authorize(actor);
    return this.repository.scoped(actor.workspaceId, async (tx) => {
      const record = await this.owned(tx, actor, connectionId);
      if (record.status !== "connected") throw new AppError("CONNECTION_UNAVAILABLE", 409);
      return tx.storedOccurrences(connectionId, record.calendarId, after);
    });
  }
  async importMeeting(actor: Actor, connectionId: string, key: string, body: unknown) {
    await this.authorize(actor);
    keySchema.parse(key);
    if (!this.meetings) throw new AppError("CALENDAR_MEETINGS_NOT_CONFIGURED", 503);
    const input = z
      .object({ occurrenceId: id, expectedVersion: z.number().int().positive() })
      .strict()
      .parse(body);
    const record = await this.repository.scoped(actor.workspaceId, async (tx) => {
      const connection = await this.owned(tx, actor, connectionId);
      if (connection.status !== "connected") throw new AppError("CONNECTION_UNAVAILABLE", 409);
      const stored = await tx.storedOccurrence(
        connectionId,
        connection.calendarId,
        input.occurrenceId,
      );
      if (!stored) throw new AppError("NOT_FOUND", 404);
      const value = z
        .object({
          id,
          version: z.number().int().positive(),
          title: z.string(),
          joinUrl: z.string().nullable(),
          status: z.enum(["confirmed", "tentative", "cancelled"]),
          allDay: z.boolean(),
          declined: z.boolean(),
          startsAt: z.string().nullable(),
          endsAt: z.string().nullable(),
        })
        .parse(stored);
      if (value.version !== input.expectedVersion) throw new AppError("VERSION_CONFLICT", 409);
      await tx.command(
        actor,
        key,
        hash(JSON.stringify(["calendar.import", connectionId, input])),
        async () => connection,
      );
      return calendarMeeting.parse({
        connectionId,
        occurrenceId: value.id,
        sourceVersion: value.version,
        title: value.title,
        joinUrl: value.joinUrl,
        status: value.status,
        allDay: value.allDay,
        declined: value.declined,
        startsAt: value.startsAt,
        endsAt: value.endsAt,
      });
    });
    await this.authority.requireActive(actor);
    const result = await this.meetings.upsert(actor, record);
    await this.authorize(actor);
    await this.repository.scoped(actor.workspaceId, async (tx) => {
      const current = await this.owned(tx, actor, connectionId);
      if (current.status !== "connected") throw new AppError("CONNECTION_UNAVAILABLE", 409);
      const source = z
        .object({ version: z.number() })
        .safeParse(await tx.storedOccurrence(connectionId, current.calendarId, input.occurrenceId));
      if (!source.success || source.data.version !== input.expectedVersion)
        throw new AppError("VERSION_CONFLICT", 409);
    });
    return result;
  }
  private async syncWork(record: Connection) {
    const job = await this.repository.scoped(record.workspaceId, (tx) =>
      tx.latestSync(record.id, true),
    );
    if (!job) return;
    if (
      record.status !== "connected" ||
      record.version !== job.connectionVersion ||
      this.now().getTime() > job.endsAt.getTime()
    ) {
      await this.repository.scoped(record.workspaceId, (tx) =>
        tx.endSync(job, "superseded", "CONNECTION_CHANGED"),
      );
      return;
    }
    const actor: Actor = {
      actorId: job.ownerId,
      workspaceId: record.workspaceId,
      sessionId: job.sessionId,
      ...(job.operationGrantId ? { operationGrantId: job.operationGrantId } : {}),
    };
    try {
      await this.withTokens(actor, record.id, async (leased, token) => {
        const page = await this.provider(record.provider).occurrences(
          token,
          job.calendarId,
          { startsAt: job.startsAt.toISOString(), endsAt: job.endsAt.toISOString() },
          job.cursor ?? undefined,
        );
        await this.authority.requireActive(actor);
        await this.repository.scoped(record.workspaceId, async (tx) => {
          const current = await tx.get(record.id);
          if (
            current?.leaseToken !== leased.leaseToken ||
            current.status !== "connected" ||
            current.version !== job.connectionVersion
          )
            throw new AppError("CONNECTION_CHANGED", 409);
          await tx.syncPage(job, page);
        });
      });
    } catch (error) {
      if (error instanceof AppError && [401, 403].includes(error.status))
        await this.repository.scoped(record.workspaceId, (tx) =>
          tx.endSync(job, "blocked", error.code),
        );
      else if (
        error instanceof AppError &&
        [
          "CALENDAR_SYNC_LIMIT",
          "CALENDAR_CURSOR_LOOP",
          "CALENDAR_INCONSISTENT_PAGE",
          "INVALID_CALENDAR_CURSOR",
          "CONNECTION_CHANGED",
        ].includes(error.code)
      )
        await this.repository.scoped(record.workspaceId, (tx) =>
          tx.endSync(
            job,
            error.code === "CONNECTION_CHANGED" ? "superseded" : "failed",
            error.code,
          ),
        );
      else throw error;
    }
  }
  async select(actor: Actor, connectionId: string, key: string, body: unknown) {
    keySchema.parse(key);
    const input = z
      .object({
        calendarId: z.string().min(1).max(2000),
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .parse(body);
    return this.withTokens(actor, connectionId, async (record, token) => {
      if (record.automatic) throw new AppError("DISABLE_AUTOMATION_FIRST", 409);
      if (record.grantId) throw new AppError("CONNECTION_BUSY", 503);
      const selected = await this.provider(record.provider).resolveCalendar(
        token,
        input.calendarId,
      );
      await this.authority.requireActive(actor);
      return this.repository
        .scoped(actor.workspaceId, (tx) =>
          tx.command(
            actor,
            key,
            hash(JSON.stringify(["calendar.select", connectionId, input])),
            async () => {
              const current = await this.owned(tx, actor, connectionId);
              if (
                current.version !== input.expectedVersion ||
                current.status !== "connected" ||
                current.leaseToken !== record.leaseToken
              )
                throw new AppError("VERSION_CONFLICT", 409);
              const updated = await tx.update(current.id, {
                calendarId: selected.id,
                calendarName: selected.name,
              });
              await tx.emit(updated);
              return updated;
            },
          ),
        )
        .then(connectionView);
    });
  }
  async disconnect(actor: Actor, connectionId: string, key: string, body: unknown) {
    await this.authorize(actor);
    keySchema.parse(key);
    const input = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(body);
    return this.repository
      .scoped(actor.workspaceId, (tx) =>
        tx.command(
          actor,
          key,
          hash(JSON.stringify(["calendar.disconnect", connectionId, input])),
          async () => {
            const current = await this.owned(tx, actor, connectionId);
            if (current.version !== input.expectedVersion)
              throw new AppError("VERSION_CONFLICT", 409);
            const updated = await tx.update(current.id, {
              status: "disconnected",
              automatic: false,
              tokenCipher: null,
              tokenExpiresAt: null,
              oauthCipher: null,
              leaseToken: null,
              leaseUntil: null,
            });
            await tx.emit(updated);
            return updated;
          },
        ),
      )
      .then(connectionView);
  }
  async work(workspaceId: string, connectionId: string) {
    const record = await this.repository.scoped(workspaceId, (tx) => tx.get(connectionId));
    if (!record) return;
    if (record.automatic && record.grantId && record.status === "connected") {
      const principal: Actor = {
        actorId: record.ownerId,
        workspaceId,
        sessionId: `operation:${record.grantId}`,
        operationGrantId: record.grantId,
      };
      try {
        const grant = await this.authority.operation(principal);
        if (grant.connectionId !== record.id) throw new AppError("FORBIDDEN", 403);
        await this.repository.scoped(workspaceId, async (tx) => {
          const current = await tx.get(record.id);
          if (
            !current?.automatic ||
            current.grantId !== record.grantId ||
            current.version !== record.version
          )
            return;
          const latest = await tx.latestSync(record.id);
          if (
            latest &&
            (["queued", "running"].includes(latest.state) ||
              this.now().getTime() - latest.createdAt.getTime() < 300000)
          )
            return;
          await tx.queueSync(
            principal,
            `background:${record.grantId}:${Math.floor(this.now().getTime() / 300000)}`,
            current,
            this.now(),
          );
        });
      } catch (error) {
        if (!(error instanceof AppError) || ![401, 403, 404].includes(error.status)) throw error;
        await this.repository.scoped(workspaceId, async (tx) => {
          const current = await tx.get(record.id);
          if (current?.automatic && current.grantId === record.grantId) {
            const updated = await tx.update(current.id, {
              automatic: false,
              errorCode: "AUTOMATION_REVOKED",
            });
            await tx.emit(updated);
          }
        });
      }
    }
    await this.syncWork(record);
    if (this.captures) {
      const current = await this.repository.scoped(workspaceId, (tx) => tx.get(connectionId));
      if (current) await this.captures.work(current);
    }
    if (
      record.status === "exchanging" &&
      record.exchangeAt &&
      this.now().getTime() > record.exchangeAt.getTime() + 60000
    ) {
      await this.repository.scoped(workspaceId, async (tx) => {
        const current = await tx.get(record.id);
        if (
          current?.status === "exchanging" &&
          current.exchangeAt &&
          this.now().getTime() > current.exchangeAt.getTime() + 60000
        ) {
          const updated = await tx.update(current.id, {
            status: "exchange_unknown",
            oauthCipher: null,
            errorCode: "OAUTH_RESPONSE_UNKNOWN",
          });
          await tx.emit(updated);
        }
      });
    }
    if (record.status === "initializing")
      await this.initialize(
        { actorId: record.ownerId, workspaceId, sessionId: record.sessionId },
        record.id,
      );
    if (!record.automatic && record.grantId) {
      const actor: Actor = {
        actorId: record.ownerId,
        workspaceId,
        operationGrantId: record.grantId,
        sessionId: `operation:${record.grantId}`,
      };
      await this.authority.disableGrant(actor, record.id);
      await this.repository.scoped(workspaceId, async (tx) => {
        const current = await tx.get(record.id);
        if (current && !current.automatic && current.grantId === record.grantId)
          await tx.update(current.id, { grantId: null });
      });
    }
  }
}
