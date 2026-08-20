"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "./supabaseClient";
import { API_BASE_URL } from "./config";

interface Me {
  user: { id: string; email: string; display_name: string | null };
  org: { id: string; name: string };
  person: { id: string; display_name: string; email: string | null } | null;
}

interface AuthContextValue {
  session: Session | null;
  me: Me | null;
  loading: boolean;
  /** Set when NEXT_PUBLIC_SUPABASE_URL/ANON_KEY aren't configured yet
   * (see docs/EXTERNAL_SETUP.md) -- the app renders instead of crashing,
   * and /login surfaces this instead of a broken sign-in form. */
  configError: string | null;
  /** Every API call site should use this instead of a bare fetch, the same
   * way every page already funnels through API_BASE_URL as the one source
   * of truth -- it's just the auth header on top of that. */
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>;
  logOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

const PUBLIC_PATHS = new Set(["/login", "/welcome", "/privacy", "/terms", "/support"]);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let client;
    try {
      client = getSupabaseClient();
    } catch (err) {
      // One-time bridge from a config check (an external system) into React
      // on mount -- same legitimate case as connections/page.tsx's
      // justConnected bridge, not the cascading-render pattern this rule
      // exists to catch.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfigError(err instanceof Error ? err.message : "Supabase is not configured.");
      setLoading(false);
      return;
    }
    client.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: listener } = client.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) setMe(null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    fetch(`${API_BASE_URL}/api/v1/me`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then(setMe)
      .catch(() => setMe(null));
  }, [session]);

  useEffect(() => {
    if (loading || session || PUBLIC_PATHS.has(pathname)) return;
    // Bare "/" gets the marketing page, not the login form -- every other
    // protected route still sends an unauthenticated visitor to /login,
    // since that's the page that actually explains what to do next.
    router.replace(pathname === "/" ? "/welcome" : "/login");
  }, [loading, session, pathname, router]);

  const authedFetch = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (session) headers.set("Authorization", `Bearer ${session.access_token}`);
      return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
    },
    [session]
  );

  const logOut = useCallback(async (): Promise<void> => {
    await getSupabaseClient().auth.signOut();
    router.replace("/login");
  }, [router]);

  return (
    <AuthContext.Provider value={{ session, me, loading, configError, authedFetch, logOut }}>
      {children}
    </AuthContext.Provider>
  );
}
