import { z } from "zod";
export const realtimeLink = z
  .object({ url: z.string().max(16000), expiresAt: z.string().datetime() })
  .strict();
export function validateRealtimeLink(value: unknown, now = Date.now()) {
  const link = realtimeLink.parse(value),
    url = new URL(link.url),
    token = url.searchParams.get("access_token");
  const ttl = Date.parse(link.expiresAt) - now;
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !/^[a-z0-9][a-z0-9-]*\.webpubsub\.azure\.com$/.test(url.hostname) ||
    url.pathname !== "/client/hubs/visualsprint_notifications" ||
    [...url.searchParams.keys()].length !== 1 ||
    !token ||
    token.length > 12000 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
    ttl < 5000 ||
    ttl > 150000
  )
    throw new Error("INVALID_REALTIME_LINK");
  // This is defense-in-depth against accidentally negotiating send/join roles,
  // not client-side JWT authentication. The backend is the issuing authority.
  const payload = JSON.parse(atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")));
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("INVALID_REALTIME_ROLES");
  // Azure's documented JWT claims use singular `role` and `webpubsub.group`.
  // Reject SDK/alias spellings as well rather than silently allowing privilege.
  for (const name of ["role", "roles", "groups", "wps.groups", "webpubsub.group"]) {
    const claim: unknown = payload[name];
    if (claim !== undefined && (!Array.isArray(claim) || claim.length !== 0))
      throw new Error("INVALID_REALTIME_ROLES");
  }
  return link;
}
export function isNotificationHint(value: unknown) {
  if (typeof value !== "string" || value.length > 128) return false;
  try {
    return z
      .object({ type: z.literal("notifications.invalidate.v1") })
      .strict()
      .safeParse(JSON.parse(value)).success;
  } catch {
    return false;
  }
}

/** URLs/tokens remain only in this closure; never persist or log negotiated credentials. */
export function startNotificationRealtime(options: {
  negotiate: (signal: AbortSignal) => Promise<unknown>;
  onHint: () => void;
  onStatus: (status: "connecting" | "connected" | "retrying" | "fallback") => void;
  open?: (url: string) => WebSocket;
}) {
  const abort = new AbortController();
  let socket: WebSocket | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    deadline: ReturnType<typeof setTimeout> | undefined,
    hintTimer: ReturnType<typeof setTimeout> | undefined,
    failures = 0,
    stopped = false;
  function disposeSocket() {
    clearTimeout(deadline);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
      socket = undefined;
    }
  }
  function failed() {
    if (stopped) return;
    disposeSocket();
    clearTimeout(timer);
    const delay = [1000, 5000, 15000][failures++];
    if (delay === undefined) {
      options.onStatus("fallback");
      return;
    }
    options.onStatus("retrying");
    timer = setTimeout(() => void connect(), delay);
  }
  async function connect() {
    if (stopped) return;
    options.onStatus("connecting");
    let link;
    try {
      link = validateRealtimeLink(
        await options.negotiate(AbortSignal.any([abort.signal, AbortSignal.timeout(10000)])),
      );
    } catch {
      // Disabled service, denied/expired access and malformed links need a deliberate
      // user retry. They never initiate login or an automatic negotiation loop.
      if (!stopped) options.onStatus("fallback");
      return;
    }
    if (stopped) return;
    try {
      socket = (options.open ?? ((url) => new WebSocket(url)))(link.url);
    } catch {
      failed();
      return;
    }
    const current = socket;
    deadline = setTimeout(failed, 5000);
    current.onopen = () => {
      if (stopped || socket !== current) return;
      clearTimeout(deadline);
      options.onStatus("connected");
      // Token expiry is not a server-side connection revocation mechanism. Close
      // and reauthorize explicitly rather than holding a socket indefinitely.
      timer = setTimeout(
        () => {
          disposeSocket();
          void connect();
        },
        Math.max(1, Date.parse(link.expiresAt) - Date.now()),
      );
    };
    current.onmessage = (event) => {
      if (stopped || socket !== current || !isNotificationHint(event.data) || hintTimer) return;
      hintTimer = setTimeout(() => {
        hintTimer = undefined;
        if (!stopped) options.onHint();
      }, 250);
    };
    current.onerror = failed;
    current.onclose = failed;
  }
  void connect();
  return () => {
    stopped = true;
    abort.abort();
    clearTimeout(timer);
    clearTimeout(hintTimer);
    disposeSocket();
  };
}
