"use client";

import { usePathname } from "next/navigation";
import { AppSidebar } from "./AppSidebar";

const NO_SIDEBAR_PATHS = new Set(["/login", "/welcome", "/privacy", "/terms", "/support"]);

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
