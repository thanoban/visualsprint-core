import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "@visualsprint/platform";
import type { Occurrence } from "../domain/occurrences.js";
const text = z.string().max(2000);
const time = z.object({
  dateTime: text.optional(),
  date: text.optional(),
  timeZone: text.optional(),
});
const google = z.object({
  id: text.min(1),
  summary: z.string().max(1000).optional(),
  status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
  start: time.optional(),
  end: time.optional(),
  originalStartTime: time.optional(),
  recurringEventId: text.optional(),
  hangoutLink: text.optional(),
  location: text.optional(),
  description: z.string().max(64000).optional(),
  conferenceData: z
    .object({
      entryPoints: z
        .array(z.object({ entryPointType: text, uri: text.optional() }))
        .max(20)
        .optional(),
    })
    .optional(),
  attendees: z
    .array(z.object({ self: z.boolean().optional(), responseStatus: text.optional() }))
    .max(1)
    .optional(),
});
const microsoft = z.object({
  id: text.min(1),
  subject: z.string().max(1000).optional(),
  isCancelled: z.boolean().optional(),
  isAllDay: z.boolean().optional(),
  start: time.optional(),
  end: time.optional(),
  responseStatus: z.object({ response: text.optional() }).optional(),
  onlineMeeting: z.object({ joinUrl: text.optional() }).nullable().optional(),
  location: z.object({ displayName: text.optional() }).optional(),
  body: z.object({ content: z.string().max(64000).optional() }).optional(),
});
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new AppError("CALENDAR_PROVIDER_UNAVAILABLE", 503);
  return result.data;
}
function instant(value?: {
  dateTime?: string | undefined;
  timeZone?: string | undefined;
}): string | null {
  if (!value?.dateTime) return null;
  let timestamp = value.dateTime;
  // Graph's UTC Prefer header can return timezone-less ISO text tagged UTC.
  if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(timestamp)) {
    if (value.timeZone !== "UTC" && value.timeZone !== "Etc/UTC")
      throw new AppError("UNSUPPORTED_CALENDAR_TIMEZONE", 503);
    timestamp += "Z";
  }
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/i.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  )
    throw new AppError("CALENDAR_PROVIDER_UNAVAILABLE", 503);
  return new Date(timestamp).toISOString();
}
function meetingLink(values: (string | undefined)[]): string | null {
  const links = new Set<string>();
  for (const value of values) {
    for (const candidate of (value ?? "").match(/https:\/\/[^\s<>"']+/g) ?? []) {
      try {
        const url = new URL(candidate.replaceAll("&amp;", "&").replace(/[),.;]+$/, ""));
        if (url.username || url.password || url.port || url.hash) continue;
        const valid =
          (url.hostname === "meet.google.com" &&
            /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)) ||
          ((url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us")) &&
            /^\/(?:j|wc\/join)\/\d+/.test(url.pathname)) ||
          (["teams.microsoft.com", "teams.live.com"].includes(url.hostname) &&
            /^\/meet(?:up-join|\/)/.test(url.pathname));
        if (valid) links.add(url.href);
      } catch {
        /* Calendar descriptions are untrusted text, never executable HTML. */
      }
    }
  }
  return links.size === 1 ? [...links][0]! : null;
}
function interval(
  startsAt: string | null,
  endsAt: string | null,
  allDay: boolean,
  cancelled: boolean,
) {
  if (!allDay && !cancelled && (!startsAt || !endsAt || startsAt >= endsAt))
    throw new AppError("CALENDAR_PROVIDER_UNAVAILABLE", 503);
}
export function googleOccurrence(raw: unknown): Occurrence {
  const event = parse(google, raw),
    status = event.status ?? "confirmed";
  const allDay = Boolean(event.start?.date),
    startsAt = allDay ? null : instant(event.start),
    endsAt = allDay ? null : instant(event.end);
  interval(startsAt, endsAt, allDay, status === "cancelled");
  const original = event.originalStartTime?.date ?? instant(event.originalStartTime);
  const identity =
    event.recurringEventId && original
      ? ["recurring", event.recurringEventId, original]
      : ["event", event.id];
  return {
    sourceKey: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    providerEventId: event.id,
    title: event.summary ?? "Untitled event",
    status,
    startsAt,
    endsAt,
    allDay,
    declined: event.attendees?.some((a) => a.self && a.responseStatus === "declined") ?? false,
    joinUrl:
      status === "cancelled"
        ? null
        : meetingLink([
            event.hangoutLink,
            ...(event.conferenceData?.entryPoints ?? [])
              .filter((e) => e.entryPointType === "video")
              .map((e) => e.uri),
            event.location,
            event.description,
          ]),
  };
}
export function microsoftOccurrence(raw: unknown): Occurrence {
  const event = parse(microsoft, raw),
    allDay = event.isAllDay ?? false;
  const startsAt = allDay ? null : instant(event.start),
    endsAt = allDay ? null : instant(event.end);
  interval(startsAt, endsAt, allDay, event.isCancelled ?? false);
  return {
    sourceKey: createHash("sha256")
      .update(JSON.stringify(["event", event.id]))
      .digest("hex"),
    providerEventId: event.id,
    title: event.subject ?? "Untitled event",
    status: event.isCancelled ? "cancelled" : "confirmed",
    startsAt,
    endsAt,
    allDay,
    declined: event.responseStatus?.response === "declined",
    joinUrl: event.isCancelled
      ? null
      : meetingLink([
          event.onlineMeeting?.joinUrl,
          event.location?.displayName,
          event.body?.content,
        ]),
  };
}
