"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import type { ConnectionOut } from "@/lib/types";

// Every vendor connect flow, even ones not wired to a real upsert yet
// (app/api/oauth.py) -- disabled entries still communicate what's coming
// rather than just not existing. `mono` is the sidebar-style monogram
// badge; `teamOnly` mirrors Settings.dc.html's TEAM_ONLY lock list.
const VENDORS = [
  { provider: "google", label: "Google", description: "Calendar watch, Meet recordings, Gmail drafts", mono: "G", teamOnly: false },
  { provider: "slack", label: "Slack", description: "Post decision recaps to a channel", mono: "SL", teamOnly: true },
  { provider: "jira", label: "Jira", description: "Create tasks from verified commitments", mono: "JR", teamOnly: true },
  { provider: "github", label: "GitHub", description: "Open issues from verified commitments", mono: "GH", teamOnly: true },
  { provider: "linear", label: "Linear", description: "Create issues from verified commitments", mono: "LN", teamOnly: true },
  { provider: "zoom", label: "Zoom", description: "Real-time capture for your Zoom account's meetings", mono: "ZM", teamOnly: false },
  { provider: "microsoft", label: "Microsoft", description: "Calendar watch, Teams recordings", mono: "MS", teamOnly: false },
];

const sans = "'IBM Plex Sans', sans-serif";
const mono = "'IBM Plex Mono', monospace";

function pillButtonStyle(active: boolean): React.CSSProperties {
  return active
    ? {
        fontFamily: sans,
        fontSize: 12.5,
        fontWeight: 600,
        color: "#fff",
        background: "var(--accent-strong)",
        border: "1px solid var(--accent-strong)",
        padding: "6px 14px",
        borderRadius: 20,
        cursor: "pointer",
      }
    : {
        fontFamily: sans,
        fontSize: 12.5,
        fontWeight: 500,
        color: "var(--text-muted)",
        background: "var(--surface2)",
        border: "1px solid var(--border)",
        padding: "6px 14px",
        borderRadius: 20,
        cursor: "pointer",
      };
}

export default function ConnectionsPage() {
  const { me, authedFetch } = useAuth();
  const [connections, setConnections] = useState<ConnectionOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState<string | null>(null);
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
    if (connected) {
      // Reads the OAuth callback's redirect query param into React state on
      // mount -- not a redundant re-derivation of existing state, this is
      // the one-time bridge from the URL (an external system) into React.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setJustConnected(connected);
      // Drop the query param so a refresh doesn't re-show the banner.
      window.history.replaceState({}, "", window.location.pathname);
    }
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
      <p style={{ fontSize: 13, color: "var(--text-faint)", padding: 32 }}>Loading…</p>
    );
  }

  const connectedByProvider = new Map(connections.map((c) => [c.provider, c]));

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--border)" }}>
        <p className="font-display" style={{ fontSize: 20, color: "var(--text)", margin: 0 }}>
          Settings
        </p>
        <p style={{ fontSize: 13, color: "var(--text-faint)", margin: "6px 0 0", maxWidth: 520 }}>
          Connect your own accounts — nobody on your team pastes an API key. Each connection
          authorizes VisualSprint through the vendor&apos;s own sign-in screen, and can be
          revoked there at any time.
        </p>
      </header>

      <main style={{ padding: "28px 32px 64px", maxWidth: 920 }}>
        {justConnected && (
          <div
            style={{
              background: "var(--accent-bg)",
              border: "1px solid var(--accent)",
              color: "var(--accent-strong)",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            Connected {justConnected}.
          </div>
        )}
        {disconnectError && (
          <div
            style={{
              background: "var(--gap-bg)",
              border: "1px solid var(--gap)",
              color: "var(--gap)",
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
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: "22px 24px",
            marginBottom: 32,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
            <div>
              <p
                className="font-mono-brand"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.03em",
                  textTransform: "uppercase",
                  color: "var(--text-faint)",
                  margin: "0 0 8px",
                }}
              >
                Plan &amp; billing
              </p>
              <p className="font-display" style={{ fontSize: 20, color: "var(--text)", margin: "0 0 4px" }}>
                {isIndividual ? "Individual — $9/mo" : "Team — $29/seat/mo"}
              </p>
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                {isIndividual
                  ? "1 seat · personal meetings · 14-day retention"
                  : "Unlimited seats · org-memory chat · unlimited retention"}
              </p>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 16 }}>
            <button type="button" onClick={() => setIsIndividual(true)} style={pillButtonStyle(isIndividual)}>
              Individual
            </button>
            <button type="button" onClick={() => setIsIndividual(false)} style={pillButtonStyle(!isIndividual)}>
              Team
            </button>
          </div>
        </section>

        <p
          className="font-mono-brand"
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            color: "var(--text-faint)",
            margin: "0 0 10px",
          }}
        >
          Connections
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {VENDORS.map((vendor) => {
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
                  padding: "18px 4px",
                  borderBottom: "1px solid var(--border)",
                  opacity: locked ? 0.5 : 1,
                }}
              >
                <div
                  className="font-mono-brand"
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 9,
                    background: "var(--surface2)",
                    border: "1px solid var(--border-strong)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    flexShrink: 0,
                  }}
                >
                  {vendor.mono}
                </div>

                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text)", margin: 0 }}>
                    {vendor.label}
                  </p>
                  <p style={{ fontSize: 12.5, color: "var(--text-faint)", margin: "3px 0 0" }}>
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
                        color: "var(--text-faint)",
                        border: "1px solid var(--border-strong)",
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
                        fontSize: 13,
                        fontWeight: 500,
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
                          background: "var(--accent)",
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
                    <p style={{ fontSize: 13, color: "var(--text-faint)", margin: 0, whiteSpace: "nowrap" }}>
                      Not connected
                    </p>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {showConnected && (
                    <button
                      type="button"
                      onClick={() => handleDisconnect(vendor.provider)}
                      disabled={disconnecting === vendor.provider}
                      style={{
                        fontFamily: sans,
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text-muted)",
                        background: "transparent",
                        border: "1px solid var(--border-strong)",
                        padding: "8px 16px",
                        borderRadius: 7,
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
                            fontSize: 13,
                            fontWeight: 600,
                            color: "var(--text-faint)",
                            background: "var(--surface2)",
                            border: "1px solid var(--border)",
                            padding: "8px 16px",
                            borderRadius: 7,
                            cursor: "not-allowed",
                            flexShrink: 0,
                          }
                        : {
                            fontFamily: sans,
                            fontSize: 13,
                            fontWeight: 600,
                            color: "#fff",
                            background: "var(--accent-strong)",
                            border: "none",
                            padding: "8px 16px",
                            borderRadius: 7,
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
      </main>
    </div>
  );
}
