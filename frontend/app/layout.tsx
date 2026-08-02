import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "VisualSprint",
  description: "Multilingual meeting intelligence — evidence-grounded organizational memory.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
            <Link href="/" className="font-semibold text-slate-900 tracking-tight">
              VisualSprint
            </Link>
            <nav className="flex gap-6 text-sm font-medium text-slate-600">
              <Link href="/upload" className="hover:text-brand-600 transition-colors">
                Upload
              </Link>
              <Link href="/chat" className="hover:text-brand-600 transition-colors">
                Chat
              </Link>
              <Link href="/glossary" className="hover:text-brand-600 transition-colors">
                Glossary
              </Link>
            </nav>
          </div>
        </header>
        <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-8">{children}</main>
        <footer className="border-t border-slate-200 py-4 text-center text-xs text-slate-400">
          VisualSprint MVP — evidence-grounded meeting intelligence
        </footer>
      </body>
    </html>
  );
}
