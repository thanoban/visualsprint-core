import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { Connection } from "../domain/records.js";
import type { TokenVault } from "./ports.js";
import { z } from "zod";
export type PushAttempt = {
  workspaceId: string;
  id: string;
  connectionId: string;
  calendarId: string;
  connectionVersion: number;
  provider: Connection["provider"];
  proofCipher: string;
  requestedExpiresAt: Date;
  leaseToken: string;
  action: "create" | "renew" | "reconcile";
  externalId: string | null;
  resourceId: string | null;
};
export type PushResult =
  | { state: "active"; externalId: string; resourceId: string | null; expiresAt: Date }
  | { state: "unknown" }
  | { state: "failed"; code: string };
export interface CalendarPushProvider {
  create(
    accessToken: string,
    input: { id: string; calendarId: string; callback: string; proof: string; expiresAt: Date },
  ): Promise<PushResult>;
  lookup(accessToken: string, attempt: PushAttempt): Promise<PushResult>;
  renew(accessToken: string, attempt: PushAttempt): Promise<PushResult>;
}
export interface CalendarPushRepository {
  plan(
    connection: Connection,
    now: Date,
    attempt: { id: string; proofHash: string; proofCipher: string; requestedExpiresAt: Date },
  ): Promise<PushAttempt | null>;
  finish(attempt: PushAttempt, result: PushResult): Promise<void>;
  retire(connection: Connection): Promise<void>;
  google(headers: Record<string, unknown>): Promise<void>;
  microsoft(body: unknown): Promise<void>;
}
export class CalendarPush {
  constructor(
    private readonly repository: CalendarPushRepository,
    private readonly providers: Partial<Record<Connection["provider"], CalendarPushProvider>>,
    private readonly vault: TokenVault,
    private readonly callbackBase?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (callbackBase) {
      const url = new URL(callbackBase);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/webhooks\/v3\/cells\/[a-z0-9-]{1,100}\/calendars\/$/.test(url.pathname)
      )
        throw new Error("INVALID_CALENDAR_PUSH_CALLBACK");
    }
  }
  configured() {
    return Boolean(this.callbackBase);
  }
  async work(connection: Connection, accessToken: string) {
    if (!this.callbackBase || !this.providers[connection.provider]) return;
    const id = randomUUID(),
      proof = randomBytes(32).toString("base64url");
    const attempt = await this.repository.plan(connection, this.now(), {
      id,
      proofHash: createHash("sha256").update(proof).digest("hex"),
      proofCipher: this.vault.seal({ proof }, `${connection.workspaceId}:${id}:calendar-push:v1`),
      requestedExpiresAt: new Date(this.now().getTime() + 86400000),
    });
    if (!attempt) return;
    const secret = z
      .object({ proof: z.string().min(32).max(256) })
      .strict()
      .parse(
        this.vault.open(
          attempt.proofCipher,
          `${attempt.workspaceId}:${attempt.id}:calendar-push:v1`,
        ),
      );
    let result: PushResult;
    try {
      result =
        attempt.action === "reconcile"
          ? await this.providers[connection.provider]!.lookup(accessToken, attempt)
          : attempt.action === "renew"
            ? await this.providers[connection.provider]!.renew(accessToken, attempt)
            : await this.providers[connection.provider]!.create(accessToken, {
                id: attempt.id,
                calendarId: attempt.calendarId,
                callback: new URL(connection.provider, this.callbackBase).href,
                proof: secret.proof,
                expiresAt: attempt.requestedExpiresAt,
              });
    } catch {
      result = { state: "unknown" };
    }
    await this.repository.finish(attempt, result);
  }
  retire(connection: Connection) {
    return this.repository.retire(connection);
  }
  google(headers: Record<string, unknown>) {
    return this.repository.google(headers);
  }
  microsoft(body: unknown) {
    return this.repository.microsoft(body);
  }
}
