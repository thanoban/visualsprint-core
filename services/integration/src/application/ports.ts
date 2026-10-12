import type { Actor } from "@visualsprint/platform";
import type { CalendarProviderName, Connection, Tokens, Calendar } from "../domain/records.js";
import type { CalendarWindow, OccurrencePage } from "../domain/occurrences.js";
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
