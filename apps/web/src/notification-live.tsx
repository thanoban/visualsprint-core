import { useEffect, useRef, useState } from "react";
import { Api } from "./api.js";
import { realtimeLink, startNotificationRealtime } from "./notification-realtime.js";
export function NotificationLive({
  api,
  workspaceId,
  changed,
  available,
}: {
  api: Api;
  workspaceId: string;
  changed: () => void;
  available: boolean;
}) {
  const [enabled, setEnabled] = useState(false),
    [status, setStatus] = useState("off");
  const callback = useRef(changed);
  callback.current = changed;
  useEffect(() => {
    if (!enabled || !available) {
      if (!available) setEnabled(false);
      setStatus("off");
      return;
    }
    const close = startNotificationRealtime({
      negotiate: (signal) =>
        api.request(`${api.scope(workspaceId)}/realtime/negotiate`, realtimeLink, {
          method: "POST",
          signal,
        }),
      onHint: () => callback.current(),
      onStatus: setStatus,
    });
    const end = () => {
      close();
      setEnabled(false);
    };
    window.addEventListener("visualsprint-session-ending", end);
    window.addEventListener("pagehide", end);
    return () => {
      close();
      window.removeEventListener("visualsprint-session-ending", end);
      window.removeEventListener("pagehide", end);
    };
  }, [api, workspaceId, enabled, available]);
  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!available}
          onChange={(event) => setEnabled(event.target.checked)}
        />{" "}
        Enable live update hints
      </label>
      <p role="status">
        Live hints: {status}. Hints contain no meeting content; updates are fetched again with
        current authorization. Authorized polling and manual refresh remain available.
      </p>
      {status === "fallback" ? (
        <p>
          Live delivery is unavailable or disabled. Toggle live hints off and on for a deliberate
          retry; your login is unchanged.
        </p>
      ) : null}
    </div>
  );
}
