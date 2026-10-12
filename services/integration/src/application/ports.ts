import type { Actor } from "@visualsprint/platform";
import type { CalendarMeeting } from "@visualsprint/contracts";
export interface CalendarMeetings {
  upsert(actor: Actor, input: CalendarMeeting): Promise<{ id: string; version: number }>;
}
import type { CalendarProviderName, Connection, Tokens, Calendar } from "../domain/records.js";
import type { CalendarWindow, OccurrencePage } from "../domain/occurrences.js";
import type { CalendarSync } from "../domain/sync.js";
export interface CalendarProvider {
  authorizationUrl(state: string, challenge: string): string;
  exchange(code: string, verifier: string): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  calendars(
    accessToken: string,
    cursor?: string,
  ): Promise<{ items: Calendar[]; nextCursor: string | null }>;
  resolveCalendar(accessToken: string, calendarId: string): Promise<Calendar>;
  occurrences(
    accessToken: string,
    calendarId: string,
    window: CalendarWindow,
    cursor?: string,
  ): Promise<OccurrencePage>;
}
export interface TokenVault {
  seal(value: unknown, context: string): string;
  open(value: string, context: string): unknown;
}
export interface CalendarAuthority {
  requireActive(actor: Actor): Promise<void>;
  operation(actor: Actor): Promise<{ connectionId: string }>;
  disableGrant(actor: Actor, connectionId: string): Promise<void>;
}
export interface ConnectionTx {
  storedOccurrence(
    connectionId: string,
    calendarId: string,
    occurrenceId: string,
  ): Promise<unknown | undefined>;
  queueSync(actor: Actor, key: string, connection: Connection, now: Date): Promise<CalendarSync>;
  latestSync(connectionId: string, activeOnly?: boolean): Promise<CalendarSync | undefined>;
  syncPage(sync: CalendarSync, page: OccurrencePage): Promise<void>;
  endSync(
    sync: CalendarSync,
    state: "failed" | "blocked" | "superseded",
    code: string,
  ): Promise<void>;
  storedOccurrences(
    connectionId: string,
    calendarId: string,
    after?: string,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  get(id: string): Promise<Connection | undefined>;
  list(ownerId: string): Promise<Connection[]>;
  create(record: Connection): Promise<Connection>;
  update(
    id: string,
    changes: Partial<
      Omit<Connection, "workspaceId" | "id" | "ownerId" | "provider" | "createdAt" | "version">
    >,
  ): Promise<Connection>;
  command(
    actor: Actor,
    key: string,
    fingerprint: string,
    create: () => Promise<Connection>,
  ): Promise<Connection>;
  emit(record: Connection): Promise<void>;
}
export interface ConnectionRepository {
  scoped<T>(workspaceId: string, work: (tx: ConnectionTx) => Promise<T>): Promise<T>;
  due(): Promise<{ workspaceId: string; connectionId: string }[]>;
  defer(workspaceId: string, connectionId: string, seconds: number): Promise<void>;
}
export type CalendarProviders = Partial<Record<CalendarProviderName, CalendarProvider>>;
