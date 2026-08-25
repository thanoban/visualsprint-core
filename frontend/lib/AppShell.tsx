"use client";

import { usePathname } from "next/navigation";
import { AppSidebar } from "./AppSidebar";

// "/" (the Meetings dashboard) renders its own full layout, including its own
// sidebar, ported from the Claude Design project's "VisualSprint App.dc.html"
// artboard -- that artboard uses its own blue token set (see app/page.tsx),
// distinct from the teal/green tokens AppSidebar uses elsewhere in the app.
// Nesting it under the shared AppSidebar would show two different sidebars
// (or a color clash) on the same screen, so it opts out here like the
// marketing page does.
const NO_SIDEBAR_PATHS = new Set(["/", "/login", "/welcome", "/privacy", "/terms", "/support"]);

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const showSidebar = !NO_SIDEBAR_PATHS.has(pathname);

  if (!showSidebar) {
    return <>{children}</>;
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <AppSidebar />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}
