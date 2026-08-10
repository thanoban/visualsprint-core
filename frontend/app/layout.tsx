import type { Metadata } from "next";
import { AuthProvider } from "@/lib/AuthProvider";
import { AppShell } from "@/lib/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "VisualSprint",
  description: "Multilingual meeting intelligence — evidence-grounded organizational memory.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
