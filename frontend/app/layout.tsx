import type { Metadata } from "next";
import { AuthProvider } from "@/lib/AuthProvider";
import { AppShell } from "@/lib/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "VisualSprint",
  description: "Meeting intelligence — evidence-grounded project and customer memory.",
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
