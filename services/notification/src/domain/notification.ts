export type NotificationKind = "summary_ready" | "action_completed" | "capture_updated";
export type DeliveryState =
  | "queued"
  | "dispatching"
  | "unknown"
  | "held"
  | "delivered"
  | "cancelled"
  | "failed";
export interface Preferences {
  workspaceId: string;
  userId: string;
  version: number;
  inApp: boolean;
  email: boolean;
  deliveryHourUtc: number | null;
}
export interface Delivery {
  id: string;
  workspaceId: string;
  userId: string;
  meetingId: string;
  eventId: string;
  kind: NotificationKind;
  sourceVersion: number;
  channel: "in_app" | "email";
  state: DeliveryState;
  version: number;
  leaseToken: string | null;
  availableAt: Date;
  externalId: string | null;
  errorCode: string | null;
  readAt: Date | null;
}
export function nextDelivery(now: Date, hourUtc: number | null): Date {
  if (hourUtc === null) return new Date(now);
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23)
    throw new Error("INVALID_DELIVERY_HOUR");
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
export type EmailResult =
  | { state: "sent"; externalId: string }
  | { state: "rejected"; code: string }
  | { state: "unknown" };
export type EmailLookup = EmailResult | { state: "pending" } | { state: "not_sent" };
