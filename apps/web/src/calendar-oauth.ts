import { z } from "zod";
import { id } from "@visualsprint/contracts";
const context = z
  .object({ workspaceId: id, connectionId: id, createdAt: z.number().int().nonnegative() })
  .strict();
const state = z
  .string()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const prefix = "visualsprint.calendar.oauth.";
export function saveCalendarFlow(
  storage: Pick<Storage, "setItem">,
  workspaceId: string,
  connectionId: string,
  authorizationUrl: string,
  now = Date.now(),
) {
  const url = new URL(authorizationUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !["accounts.google.com", "login.microsoftonline.com"].includes(url.hostname)
  )
    throw new Error("INVALID_CALENDAR_AUTHORIZATION_URL");
  const nonce = state.parse(url.searchParams.get("state"));
  storage.setItem(
    prefix + nonce,
    JSON.stringify(context.parse({ workspaceId, connectionId, createdAt: now })),
  );
  return url.href;
}
export function calendarFlow(storage: Pick<Storage, "getItem">, nonce: string, now = Date.now()) {
  const raw = storage.getItem(prefix + state.parse(nonce));
  if (!raw) throw new Error("CALENDAR_FLOW_NOT_FOUND");
  const parsed = context.parse(JSON.parse(raw));
  if (parsed.createdAt > now || now - parsed.createdAt > 600000)
    throw new Error("CALENDAR_FLOW_EXPIRED");
  return parsed;
}
export function removeCalendarFlow(storage: Pick<Storage, "removeItem">, nonce: string) {
  storage.removeItem(prefix + state.parse(nonce));
}
export function calendarReturn(url: string) {
  const params = new URL(url).searchParams;
  return z
    .object({ state, code: z.string().min(1).max(16000) })
    .parse({ state: params.get("state"), code: params.get("code") });
}
