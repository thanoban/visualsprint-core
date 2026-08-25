"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "./AuthProvider";

interface NavItem {
  key: string;
  label: string;
  href: string;
  glyph: string;
}

// Matches the nav set in the Claude Design project's AppSidebar.dc.html,
// plus Glossary/Data rights, which exist in this app but not in that
// project's 5-page scope -- dropping them would be a real regression, so
// they're appended with the same glyph-badge treatment.
const NAV_ITEMS: NavItem[] = [
  { key: "meetings", label: "Meetings", href: "/meetings", glyph: "M" },
  { key: "chat", label: "Org Chat", href: "/chat", glyph: "C" },
  { key: "upload", label: "Upload", href: "/upload", glyph: "U" },
  { key: "people", label: "People", href: "/people", glyph: "P" },
  { key: "actions", label: "Actions", href: "/actions", glyph: "A" },
  { key: "glossary", label: "Glossary", href: "/glossary", glyph: "Gl" },
  { key: "data-rights", label: "Data rights", href: "/data-rights", glyph: "DR" },
  { key: "settings", label: "Connections", href: "/settings/connections", glyph: "S" },
];

function activeKeyFor(pathname: string): string {
  const match = NAV_ITEMS.find((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
  );
  return match?.key ?? "";
}

function initials(label: string): string {
  const parts = label.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

export function AppSidebar() {
  const pathname = usePathname();
  const activeKey = activeKeyFor(pathname);
  const { me, logOut } = useAuth();
  // Lazy initializer, not an effect -- reads localStorage once during the
  // client render pass. window is unavailable during SSR, hence the guard;
  // Next hydrates this the same way on first paint so there's no mismatch
  // flash beyond the same one every theme-persisting site accepts.
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof window !== "undefined" && window.localStorage.getItem("vs-theme") === "dark"
      ? "dark"
      : "light"
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("vs-theme", next);
  }

  const orgLabel = me?.org.name ?? "Personal workspace";
  const userLabel = me?.user.display_name || me?.user.email || "Signed in";

  return (
    <div
      style={{
        width: 248,
        flexShrink: 0,
        minHeight: "100vh",
        background: "var(--surface2)",
        borderRight: "1px solid var(--border)",
        padding: "22px 16px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        boxSizing: "border-box",
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 8px", marginBottom: 18 }}>
          <span className="font-mono-brand" style={{ color: "var(--accent)", fontWeight: 600 }}>
            [
          </span>
          <span className="font-display" style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>
            VisualSprint
          </span>
          <span className="font-mono-brand" style={{ color: "var(--accent)", fontWeight: 600 }}>
            ]
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 13,
            fontWeight: 500,
            color: "var(--text-muted)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            padding: "9px 12px",
          }}
        >
          <span>{orgLabel}</span>
        </div>

        <nav style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV_ITEMS.map((item) => {
            const isActive = item.key === activeKey;
            return (
              <Link
                key={item.key}
                href={item.href}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 10px",
                  borderRadius: 7,
                  fontSize: 13.5,
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? "var(--accent-strong)" : "var(--text-muted)",
                  background: isActive ? "var(--accent-bg)" : "transparent",
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  className="font-mono-brand"
                  style={{
                    width: 22,
                    height: 22,
                    flexShrink: 0,
                    border: `1px solid ${isActive ? "var(--accent)" : "var(--border-strong)"}`,
                    borderRadius: 5,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    color: isActive ? "var(--accent-strong)" : "var(--text-faint)",
                    background: isActive ? "var(--surface)" : "transparent",
                  }}
                >
                  {item.glyph}
                </span>
                <span>{isActive ? `[ ${item.label} ]` : item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <div>
        <button
          type="button"
          onClick={toggleTheme}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "none",
            border: "none",
            padding: "9px 10px",
            marginBottom: 10,
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 500,
            color: "var(--text-muted)",
            fontFamily: "'IBM Plex Sans', sans-serif",
          }}
        >
          <span>{theme === "dark" ? "Dark mode" : "Light mode"}</span>
          <span
            style={{
              width: 34,
              height: 19,
              borderRadius: 20,
              background: "var(--accent)",
              position: "relative",
              display: "inline-block",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: theme === "dark" ? 17 : 2,
                width: 15,
                height: 15,
                borderRadius: "50%",
                background: "#fff",
                transition: "left 120ms ease",
              }}
            />
          </span>
        </button>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 10,
            borderTop: "1px solid var(--border)",
          }}
        >
          <div
            className="font-mono-brand"
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              background: "var(--accent)",
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {initials(userLabel)}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text)",
                margin: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {userLabel}
            </p>
            <button
              type="button"
              onClick={logOut}
              style={{
                fontSize: 11.5,
                color: "var(--text-faint)",
                margin: 0,
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
              }}
            >
              Log out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
