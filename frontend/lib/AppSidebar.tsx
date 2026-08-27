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

// Split into the Claude Design project's Workspace/Setup groups
// (VisualSprint App.dc.html's NAV/NAV_SETUP). Glossary is relabeled
// "Vocabulary" here (route/API stay /glossary); Data rights has no mockup
// equivalent but dropping it would be a real regression, so it's appended
// to Setup with the same glyph-badge treatment.
const NAV_WORKSPACE: NavItem[] = [
  { key: "meetings", label: "Meetings", href: "/meetings", glyph: "M" },
  { key: "chat", label: "Org Chat", href: "/chat", glyph: "C" },
  { key: "upload", label: "Upload", href: "/upload", glyph: "U" },
  { key: "people", label: "People", href: "/people", glyph: "P" },
  { key: "actions", label: "Actions", href: "/actions", glyph: "A" },
];
const NAV_SETUP: NavItem[] = [
  { key: "settings", label: "Connections", href: "/settings/connections", glyph: "S" },
  { key: "glossary", label: "Vocabulary", href: "/glossary", glyph: "V" },
  { key: "data-rights", label: "Data rights", href: "/data-rights", glyph: "DR" },
];
const NAV_ITEMS: NavItem[] = [...NAV_WORKSPACE, ...NAV_SETUP];

function activeKeyFor(pathname: string): string {
  const match = NAV_ITEMS.find((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
  );
  return match?.key ?? "";
}

function NavLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
  return (
    <Link
      href={item.href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 10px",
        borderRadius: 9,
        fontSize: 13.5,
        fontWeight: 600,
        color: isActive ? "var(--blue-strong)" : "var(--muted)",
        background: isActive ? "var(--blue-soft)" : "transparent",
        whiteSpace: "nowrap",
      }}
    >
      <span
        className="font-mono-brand"
        style={{
          width: 22,
          height: 22,
          flexShrink: 0,
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10.5,
          fontWeight: 600,
          color: isActive ? "var(--blue-strong)" : "var(--faint)",
          background: isActive ? "#fff" : "var(--soft)",
        }}
      >
        {item.glyph}
      </span>
      <span>{item.label}</span>
    </Link>
  );
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
        width: 244,
        flexShrink: 0,
        minHeight: "100vh",
        background: "var(--bg)",
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
          <span className="font-mono-brand" style={{ color: "var(--blue)", fontWeight: 600 }}>
            [
          </span>
          <span className="font-display" style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>
            VisualSprint
          </span>
          <span className="font-mono-brand" style={{ color: "var(--blue)", fontWeight: 600 }}>
            ]
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 12.5,
            fontWeight: 700,
            color: "var(--text)",
            background: "var(--soft)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "9px 11px",
            marginBottom: 16,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{orgLabel}</span>
        </div>

        <p
          className="font-mono-brand"
          style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)", margin: "0 0 8px", padding: "0 10px" }}
        >
          Workspace
        </p>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV_WORKSPACE.map((item) => (
            <NavLink key={item.key} item={item} isActive={item.key === activeKey} />
          ))}
        </nav>

        <p
          className="font-mono-brand"
          style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)", margin: "18px 0 8px", padding: "0 10px" }}
        >
          Setup
        </p>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV_SETUP.map((item) => (
            <NavLink key={item.key} item={item} isActive={item.key === activeKey} />
          ))}
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
            color: "var(--muted)",
            fontFamily: "'Plus Jakarta Sans', sans-serif",
          }}
        >
          <span>{theme === "dark" ? "Dark mode" : "Light mode"}</span>
          <span
            style={{
              width: 34,
              height: 19,
              borderRadius: 20,
              background: "var(--blue)",
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
              background: "var(--blue)",
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
                color: "var(--faint)",
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
