import type { Actor } from "@visualsprint/platform";
import type { DomainEvent } from "@visualsprint/contracts";
import type { Delivery, Preferences, EmailResult, EmailLookup } from "../domain/notification.js";
export interface Authority {
  requireSession(actor: Actor): Promise<void>;
  profile(
    workspaceId: string,
    userId: string,
    deliveryId?: string,
  ): Promise<{ verifiedEmail: string | null }>;
  source(
    workspaceId: string,
    userId: string,
    meetingId: string,
    deliveryId?: string,
  ): Promise<{ version: number }>;
}
export interface EmailPort {
  readonly configured: boolean;
  prepare?(): Promise<void>;
  send(input: {
    deliveryId: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<EmailResult>;
  lookup(deliveryId: string): Promise<EmailLookup>;
}
/** Only a content-free invalidation hint. Source data always uses authorized HTTP reads. */
export interface RealtimePort {
  readonly configured: boolean;
  negotiate(workspaceId: string, userId: string): Promise<{ url: string; expiresAt: string }>;
  invalidate(workspaceId: string, userId: string): Promise<void>;
}
export interface NotificationTransaction {
  preferences(userId: string): Promise<Preferences>;
  savePreferences(
    userId: string,
    key: string,
    expectedVersion: number,
    input: { inApp: boolean; email: boolean; deliveryHourUtc: number | null },
  ): Promise<Preferences>;
  consume(event: DomainEvent): Promise<void>;
  delivery(id: string, userId?: string): Promise<Delivery>;
  list(userId: string, after?: string): Promise<Delivery[]>;
  claim(id: string): Promise<Delivery | null>;
  startEmail(delivery: Delivery): Promise<void>;
  finish(
    delivery: Delivery,
    state: Delivery["state"],
    code: string | null,
    externalId: string | null,
  ): Promise<void>;
  markRead(id: string, userId: string, expectedVersion: number): Promise<Delivery>;
  deleteMeeting(deletionId: string, meetingId: string, sourceVersion: number): Promise<void>;
}
export interface Repository {
  transaction<T>(
    workspaceId: string,
    work: (tx: NotificationTransaction) => Promise<T>,
  ): Promise<T>;
  due(): Promise<{ workspaceId: string; deliveryId: string }[]>;
  reschedule(workspaceId: string, deliveryId: string, seconds?: number): Promise<void>;
}
