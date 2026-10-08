"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import { apiJson, workspacePath } from "@/lib/founder-api";

/** A scope change never renders the previous workspace's cached result. */
export function useWorkspaceData<T>(suffix: string | null) {
  const { me, authedFetch } = useAuth();
  const path = me && suffix ? workspacePath(me.org.id, suffix) : null;
  const identity = path && me ? `${me.user.id}:${path}` : null;
  const [result, setResult] = useState<{ path: string; data?: T; error?: string } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path || !identity) return;
    const controller = new AbortController();
    apiJson<T>(authedFetch, path, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setResult({ path: identity, data }); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ path: identity, error: error instanceof Error ? error.message : "Unable to load data" });
      });
    return () => controller.abort();
  }, [path, identity, authedFetch, revision]);
  const refresh = useCallback(() => { setResult(null); setRevision((value) => value + 1); }, []);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  return { data: result?.path === identity ? result?.data : undefined, error: result?.path === identity ? result?.error : undefined, refresh };
}
