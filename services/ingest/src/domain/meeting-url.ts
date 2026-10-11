export type MeetingPlatform = "google_meet" | "zoom" | "microsoft_teams";
export type MeetingLink = Readonly<{ platform: MeetingPlatform; url: string }>;

export function parseMeetingLink(input: string): MeetingLink {
  if (input.length > 4096) throw new Error("INVALID_LINK");
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("INVALID_LINK"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error("INVALID_LINK");
  }
  const host = url.hostname.toLowerCase();
  if (host === "meet.google.com" && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)) {
    return { platform: "google_meet", url: url.href };
  }
  if ((host === "zoom.us" || host.endsWith(".zoom.us"))
    && /^\/(?:j|wc\/join)\/\d{9,11}\/?$/.test(url.pathname)) {
    return { platform: "zoom", url: url.href };
  }
  if ((host === "teams.microsoft.com" || host === "teams.live.com")
    && (/^\/l\/meetup-join\/[^/]+\//.test(url.pathname)
      || /^\/meet\/\d+\/?$/.test(url.pathname))) {
    return { platform: "microsoft_teams", url: url.href };
  }
  throw new Error("INVALID_LINK");
}
