"use client";

// Restyled to the Claude Design project "VisualSprint landing redesign" ->
// VisualSprint App.dc.html (Connections screen). Vendors are grouped into
// the mockup's three sections (Meeting capture / Work tracking / Delivery)
// -- pure reordering of the same real VENDORS array, no data change. Kept
// the existing text-monogram vendor badges rather than the mockup's
// external simple-icons CDN masks: an extra third-party asset dependency
// for a cosmetic icon is a real reliability trade against an
// already-working, self-contained badge.

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type { ConnectionOut } from "@/lib/types";

type Group = "Meeting capture" | "Work tracking" | "Delivery";

// Every vendor connect flow, even ones not wired to a real upsert yet
// (app/api/oauth.py) -- disabled entries still communicate what's coming
// rather than just not existing. `mono` is the sidebar-style monogram
// badge; `teamOnly` mirrors the mockup's TEAM_ONLY lock list.
const VENDORS: { provider: string; label: string; description: string; mono: string; teamOnly: boolean; group: Group }[] = [
  { provider: "zoom", label: "Zoom", description: "Real-time capture for your Zoom account's meetings", mono: "ZM", teamOnly: false, group: "Meeting capture" },
  { provider: "google", label: "Google", description: "Calendar watch, Meet recordings, Gmail drafts", mono: "G", teamOnly: false, group: "Meeting capture" },
  { provider: "microsoft", label: "Microsoft", description: "Calendar watch, Teams recordings", mono: "MS", teamOnly: false, group: "Meeting capture" },
  { provider: "jira", label: "Jira", description: "Create tasks from verified commitments", mono: "JR", teamOnly: true, group: "Work tracking" },
  { provider: "linear", label: "Linear", description: "Create issues from verified commitments", mono: "LN", teamOnly: true, group: "Work tracking" },
  { provider: "github", label: "GitHub", description: "Open issues from verified commitments", mono: "GH", teamOnly: true, group: "Work tracking" },
  { provider: "slack", label: "Slack", description: "Post decision recaps to a channel", mono: "SL", teamOnly: true, group: "Delivery" },
];

const GROUP_HINT: Record<Group, string> = {
  "Meeting capture": "where recordings come from",
  "Work tracking": "tasks created only from verified commitments",
  Delivery: "recaps and follow-ups still need approval",
};
const GROUPS: Group[] = ["Meeting capture", "Work tracking", "Delivery"];

const sans = "'Plus Jakarta Sans', sans-serif";

// microsoft_teams is a real OAuth provider key (incremental-consent step,
// app/oauth/providers.py) but isn't its own row in VENDORS -- it writes to
// the same "microsoft" CalendarConnection. Only its redirect banner needs a
// human label.
function friendlyProviderLabel(provider: string): string {
  return provider === "microsoft_teams" ? "Teams recording" : provider;
}

function pillButtonStyle(active: boolean): React.CSSProperties {
  return active
    ? {
        fontFamily: sans,
        fontSize: 12.5,
        fontWeight: 700,
        color: "var(--text)",
        background: "#fff",
        border: "none",
        padding: "7px 15px",
        borderRadius: 999,
        cursor: "pointer",
      }
    : {
        fontFamily: sans,
        fontSize: 12.5,
        fontWeight: 700,
        color: "rgba(255,255,255,.6)",
        background: "transparent",
        border: "none",
        padding: "7px 15px",
        borderRadius: 999,
        cursor: "pointer",
      };
}

export default function ConnectionsPage() {
  const { me, authedFetch } = useAuth();
  const [connections, setConnections] = useState<ConnectionOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  // Plan/billing has no backend yet -- purely local UI state, same as the
  // Claude Design mockup this page is built from. Individual just locks
  // the team-only connectors so the page communicates the real product
  // shape ahead of an actual billing system.
  const [isIndividual, setIsIndividual] = useState(false);

  async function handleDisconnect(provider: string) {
    if (!me) return;
    setDisconnecting(provider);
    setDisconnectError(null);
    try {
      const res = await authedFetch(`/api/v1/orgs/${me.org.id}/connections/${provider}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setConnections((prev) => (prev ? prev.filter((c) => c.provider !== provider) : prev));
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnecting(null);
    }
  }

  async function handleConnect(provider: string) {
    if (!me) return;
    setConnecting(provider);
    setDisconnectError(null);
    try {
      // Backend returns the authorize URL as JSON rather than redirecting
      // directly -- a plain <a href> browser navigation can't carry the
      // Authorization header the org-membership check needs. Fetch it
      // authenticated, then navigate the browser there ourselves.
      const res = await authedFetch(`/api/v1/orgs/${me.org.id}/oauth/${provider}/authorize`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const { authorize_url } = (await res.json()) as { authorize_url: string };
      window.location.href = authorize_url;
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : "Failed to start connection.");
      setConnecting(null);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const oauthError = params.get("oauth_error");
    if (connected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setJustConnected(connected);
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (oauthError) {
      setConnectError(`Failed to connect ${friendlyProviderLabel(oauthError)}. Please try again.`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // Reset connecting state on bfcache restore (browser Back after OAuth
  // redirect). Without this, "Redirecting…" stays stuck on the button
  // because browser Back restores the previous React state intact.
  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setConnecting(null);
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  useEffect(() => {
    if (!me) return;
    authedFetch(`/api/v1/orgs/${me.org.id}/connections`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<ConnectionOut[]>;
      })
      .then(setConnections)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load connections."));
  }, [me, authedFetch]);

  if (error) {
    return (
      <p className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 m-8">
        {error}
      </p>
    );
  }

  if (!me || connections === null) {
    return (
      <p style={{ fontSize: 13, color: "var(--faint)", padding: 32 }}>Loading…</p>
    );
  }

  const connectedByProvider = new Map(connections.map((c) => [c.provider, c]));

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--border)" }}>
        <p style={{ fontFamily: sans, fontWeight: 800, fontSize: 19, letterSpacing: "-0.02em", color: "var(--text)", margin: 0 }}>
          Connections
        </p>
        <p style={{ fontSize: 13, color: "var(--faint)", margin: "6px 0 0", maxWidth: 560 }}>
          Every connection is authorised through the vendor&apos;s own sign-in screen and can be
          revoked there at any time. Nobody on your team ever pastes an API key.
        </p>
      </header>

      <main style={{ padding: "28px 32px 64px", maxWidth: 940 }}>
        {justConnected && (
          <div
            style={{
              background: "var(--green-soft)",
              border: "1px solid var(--green)",
              color: "var(--green)",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            Connected {friendlyProviderLabel(justConnected)}.
          </div>
        )}
        {connectError && (
          <div
            style={{
              background: "var(--red-soft)",
              border: "1px solid var(--red)",
              color: "var(--red)",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            {connectError}
          </div>
        )}
        {disconnectError && (
          <div
            style={{
              background: "var(--red-soft)",
              border: "1px solid var(--red)",
              color: "var(--red)",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            {disconnectError}
          </div>
        )}

        <section
          style={{
            background: "var(--text)",
            borderRadius: 18,
            padding: "22px 24px",
            marginBottom: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 20,
            flexWrap: "wrap",
          }}
        >
          <div>
            <p
              className="font-mono-brand"
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,.5)",
                margin: "0 0 8px",
              }}
            >
              Plan &amp; billing
            </p>
            <p style={{ fontFamily: sans, fontWeight: 800, fontSize: 22, letterSpacing: "-0.02em", color: "#fff", margin: "0 0 6px" }}>
              {isIndividual ? "Individual — $9 / mo" : "Team — $29 / seat / mo"}
            </p>
            <p style={{ fontSize: 12.5, color: "rgba(255,255,255,.62)", margin: 0 }}>
              {isIndividual
                ? "1 seat · personal meetings · 14-day retention"
                : "Unlimited seats · org-memory chat · unlimited retention"}
            </p>
          </div>
          <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,.1)", borderRadius: 999, padding: 4 }}>
            <button type="button" onClick={() => setIsIndividual(true)} style={pillButtonStyle(isIndividual)}>
              Individual
            </button>
            <button type="button" onClick={() => setIsIndividual(false)} style={pillButtonStyle(!isIndividual)}>
              Team
            </button>
          </div>
        </section>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {GROUPS.map((group) => (
            <div key={group}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 14, margin: "0 4px 10px" }}>
                <p className="font-mono-brand" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)", margin: 0 }}>
                  {group}
                </p>
                <p style={{ fontSize: 11.5, color: "var(--faint)", margin: 0 }}>{GROUP_HINT[group]}</p>
              </div>
              <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden" }}>
                {VENDORS.filter((v) => v.group === group).map((vendor) => {
                  const connection = connectedByProvider.get(vendor.provider);
                  const locked = isIndividual && vendor.teamOnly;
                  const showConnected = !!connection && !locked;

                  return (
                    <div
                      key={vendor.provider}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "38px minmax(200px, 1fr) 160px auto",
                        alignItems: "center",
                        gap: 16,
                        padding: "15px 18px",
                        borderBottom: "1px solid var(--border)",
                        opacity: locked ? 0.5 : 1,
                      }}
                    >
                      <div
                        className="font-mono-brand"
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: 11,
                          background: "var(--soft)",
                          border: "1px solid var(--border)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 12.5,
                          fontWeight: 700,
                          color: "var(--muted)",
                          flexShrink: 0,
                        }}
                      >
                        {vendor.mono}
                      </div>

                      <div style={{ minWidth: 0 }}>
                        <p style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", margin: 0 }}>
                          {vendor.label}
                        </p>
                        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "3px 0 0" }}>
                          {vendor.description}
                        </p>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, overflow: "hidden", minWidth: 0 }}>
                        {locked && (
                          <span
                            className="font-mono-brand"
                            style={{
                              fontSize: 10.5,
                              fontWeight: 600,
                              color: "var(--faint)",
                              border: "1px solid var(--border-2)",
                              padding: "2px 8px",
                              borderRadius: 4,
                              whiteSpace: "nowrap",
                              flexShrink: 0,
                            }}
                          >
                            Team plan
                          </span>
                        )}
                        {showConnected && (
                          <p
                            style={{
                              fontSize: 12.5,
                              fontWeight: 600,
                              color: "var(--text)",
                              margin: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              overflow: "hidden",
                              minWidth: 0,
                            }}
                          >
                            <span
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: "50%",
                                background: "var(--green)",
                                display: "inline-block",
                                flexShrink: 0,
                              }}
                            />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {connection.account_label}
                            </span>
                          </p>
                        )}
                        {!locked && !showConnected && (
                          <p style={{ fontSize: 13, color: "var(--faint)", margin: 0, whiteSpace: "nowrap" }}>
                            Not connected
                          </p>
                        )}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {vendor.provider === "microsoft" && showConnected && (
                          connection?.teams_scope_granted ? (
                            <span
                              className="font-mono-brand"
                              style={{
                                fontSize: 10.5,
                                fontWeight: 600,
                                color: "var(--green)",
                                border: "1px solid var(--green)",
                                background: "var(--green-soft)",
                                padding: "2px 8px",
                                borderRadius: 4,
                                whiteSpace: "nowrap",
                                flexShrink: 0,
                              }}
                            >
                              Teams enabled
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleConnect("microsoft_teams")}
                              disabled={connecting === "microsoft_teams"}
                              title="Grants OnlineMeetings.Read.All so VisualSprint can pull Teams cloud recordings/transcripts (Mode A2). Only meaningful for a work/school account -- personal Microsoft accounts don't have this permission."
                              style={{
                                fontFamily: sans,
                                fontSize: 12.5,
                                fontWeight: 700,
                                color: "var(--muted)",
                                background: "var(--bg)",
                                border: "1px solid var(--border-2)",
                                padding: "8px 16px",
                                borderRadius: 999,
                                cursor: connecting === "microsoft_teams" ? "default" : "pointer",
                                flexShrink: 0,
                                opacity: connecting === "microsoft_teams" ? 0.6 : 1,
                              }}
                            >
                              {connecting === "microsoft_teams" ? "Redirecting…" : "Enable Teams recording"}
                            </button>
                          )
                        )}
                        {showConnected && (
                          <button
                            type="button"
                            onClick={() => handleDisconnect(vendor.provider)}
                            disabled={disconnecting === vendor.provider}
                            style={{
                              fontFamily: sans,
                              fontSize: 12.5,
                              fontWeight: 700,
                              color: "var(--muted)",
                              background: "var(--bg)",
                              border: "1px solid var(--border-2)",
                              padding: "8px 16px",
                              borderRadius: 999,
                              cursor: disconnecting === vendor.provider ? "default" : "pointer",
                              flexShrink: 0,
                              opacity: disconnecting === vendor.provider ? 0.6 : 1,
                            }}
                          >
                            {disconnecting === vendor.provider ? "Disconnecting…" : "Disconnect"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleConnect(vendor.provider)}
                          disabled={locked || connecting === vendor.provider}
                          style={
                            locked
                              ? {
                                  fontFamily: sans,
                                  fontSize: 12.5,
                                  fontWeight: 700,
                                  color: "var(--faint)",
                                  background: "var(--soft)",
                                  border: "1px solid var(--border)",
                                  padding: "8px 18px",
                                  borderRadius: 999,
                                  cursor: "not-allowed",
                                  flexShrink: 0,
                                }
                              : {
                                  fontFamily: sans,
                                  fontSize: 12.5,
                                  fontWeight: 700,
                                  color: "#fff",
                                  background: "var(--blue)",
                                  border: "none",
                                  padding: "8px 18px",
                                  borderRadius: 999,
                                  cursor: connecting === vendor.provider ? "default" : "pointer",
                                  flexShrink: 0,
                                  opacity: connecting === vendor.provider ? 0.7 : 1,
                                }
                          }
                        >
                          {locked
                            ? "Locked"
                            : connecting === vendor.provider
                              ? "Redirecting…"
                              : connection
                                ? "Reconnect"
                                : "Connect"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
