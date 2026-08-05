"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/config";
import type { ConnectionOut } from "@/lib/types";

/** No auth/org-selection yet -- resolve the dev-convenience "default" org
 * name to its real id, same pattern as every other settings-style page. */
async function resolveDefaultOrgId(): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/v1/orgs/default`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const org = (await res.json()) as { id: string; name: string };
  return org.id;
}

async function fetchConnections(orgId: string): Promise<ConnectionOut[]> {
  const res = await fetch(`${API_BASE_URL}/api/v1/orgs/${orgId}/connections`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as ConnectionOut[];
}

// Every vendor connect flow, even ones not wired to a real upsert yet
// (app/api/oauth.py) -- disabled entries still communicate what's coming
// rather than just not existing.
const VENDORS = [
  { provider: "google", label: "Google", description: "Calendar watch, Meet recordings, Gmail drafts", ready: true },
  { provider: "slack", label: "Slack", description: "Post decision recaps to a channel", ready: true },
  { provider: "jira", label: "Jira", description: "Create tasks from verified commitments", ready: true },
  { provider: "github", label: "GitHub", description: "Open issues from verified commitments", ready: true },
  { provider: "linear", label: "Linear", description: "Create issues from verified commitments", ready: true },
  { provider: "zoom", label: "Zoom", description: "Real-time capture for your own account's meetings", ready: false },
];

export default function ConnectionsPage() {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState<string | null>(null);

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
    resolveDefaultOrgId()
      .then((id) => {
        setOrgId(id);
        return fetchConnections(id);
      })
      .then(setConnections)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load connections."));
  }, []);

  if (error) {
    return (
      <p className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
        {error}
      </p>
    );
  }

  if (!orgId || connections === null) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  const connectedByProvider = new Map(connections.map((c) => [c.provider, c]));

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Connections</h1>
        <p className="mt-1 text-sm text-slate-600">
          Connect your own accounts -- nobody on your team ever pastes an API key. Each
          connection authorizes VisualSprint against your account through the vendor&apos;s
          own sign-in screen, and can be revoked there at any time.
        </p>
      </div>

      {justConnected && (
        <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800">
          Connected {justConnected}.
        </div>
      )}

      <div className="space-y-3">
        {VENDORS.map((vendor) => {
          const connection = connectedByProvider.get(vendor.provider);
          return (
            <div
              key={vendor.provider}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4"
            >
              <div>
                <h2 className="text-sm font-semibold text-slate-900">{vendor.label}</h2>
                <p className="mt-1 text-sm text-slate-600">{vendor.description}</p>
                {connection && (
                  <p className="mt-1 text-xs text-green-700">Connected as {connection.account_label}</p>
                )}
              </div>
              {vendor.ready ? (
                <a
                  href={`${API_BASE_URL}/api/v1/orgs/${orgId}/oauth/${vendor.provider}/authorize`}
                  className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 whitespace-nowrap"
                >
                  {connection ? "Reconnect" : "Connect"}
                </a>
              ) : (
                <span className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-400 whitespace-nowrap">
                  Coming soon
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
