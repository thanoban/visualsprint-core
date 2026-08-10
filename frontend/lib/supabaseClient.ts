import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

// Single browser Supabase client, shared by every "use client" component
// via lib/AuthProvider.tsx -- mirrors API_BASE_URL's role in lib/config.ts
// as the one source of truth every call site agrees on.
//
// createBrowserClient() throws immediately if the URL/key are missing, and
// Next.js evaluates client-component modules during prerendering (even for
// pages that never touch auth, e.g. /_not-found) -- so before the real
// Supabase project exists (see docs/EXTERNAL_SETUP.md), that throw would
// break the production build entirely. Lazy-init instead: the build
// succeeds either way, and only a real attempt to sign in surfaces a clear
// runtime error, same as every other missing-credential path in this app.
let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase is not configured -- set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see docs/EXTERNAL_SETUP.md)"
    );
  }
  _client = createBrowserClient(url, key);
  return _client;
}
