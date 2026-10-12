import { StrictMode, useCallback, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { AuthKitProvider, useAuth } from "@workos-inc/authkit-react";
import { Api } from "./api.js";
import { Product } from "./product.js";
import { CalendarCallback } from "./calendar-panel.js";
import { calendarReturn } from "./calendar-oauth.js";
import "./styles.css";

// Remove the calendar provider's code before AuthKit mounts. It is not a WorkOS
// authorization code and must never be consumed by the login SDK or retained in URLs.
const isCalendarReturn = window.location.pathname === "/oauth/calendar";
let calendarResult: ReturnType<typeof calendarReturn> | null = null;
if (isCalendarReturn) {
  try {
    calendarResult = calendarReturn(window.location.href);
  } catch {
    /* consent declined/invalid return */
  }
  window.history.replaceState(null, "", "/oauth/calendar");
}

function Session() {
  const { isLoading, user, signIn, signOut, getAccessToken } = useAuth();
  const api = useMemo(() => new Api(() => getAccessToken()), [getAccessToken]);
  const endSession = useCallback(() => signOut({ returnTo: window.location.origin }), [signOut]);
  useEffect(() => {
    if (window.location.pathname === "/login") void signIn();
  }, [signIn]);
  if (isLoading)
    return (
      <main className="welcome">
        <p role="status">Loading your session…</p>
      </main>
    );
  if (!user)
    return (
      <main className="welcome">
        <span className="eyebrow">VISUALSPRINT</span>
        <h1>
          Your meetings.
          <br />
          One clear next step.
        </h1>
        <p>A private workspace for customer conversations, projects and follow-through.</p>
        <button onClick={() => void signIn()}>Sign in</button>
      </main>
    );
  if (isCalendarReturn) return <CalendarCallback api={api} result={calendarResult} />;
  return <Product key={user.id} api={api} email={user.email} signOut={endSession} />;
}
const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID as string | undefined;
const apiHostname = import.meta.env.VITE_WORKOS_API_HOSTNAME as string | undefined;
const root = createRoot(document.getElementById("root")!);
if (!clientId || (!import.meta.env.DEV && !apiHostname)) {
  root.render(
    <main className="welcome">
      <h1>VisualSprint setup required</h1>
      <p>
        Configure the WorkOS client ID and production authentication domain before signing in. No
        guest or demo access is enabled.
      </p>
    </main>,
  );
} else {
  root.render(
    <StrictMode>
      <AuthKitProvider
        clientId={clientId}
        {...(apiHostname ? { apiHostname } : {})}
        devMode={import.meta.env.DEV}
        onRedirectCallback={() => window.history.replaceState(null, "", "/")}
      >
        <Session />
      </AuthKitProvider>
    </StrictMode>,
  );
}
