"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/config";
import { mockAssistantReply } from "@/lib/mock-data";
import type { ChatMessage, ChatRequest, ChatResponse, EvidenceChip } from "@/lib/types";

/** No auth/org-selection exists yet -- every page targets the dev-convenience
 * org NAME "default" (upload.py's auto-create convention). That name is not
 * the UUID `/api/v1/chat` filters KnowledgeItem rows by, so it must be
 * resolved via GET /api/v1/orgs/default first. Previously this page sent the
 * literal string "default" as org_id: chat.py doesn't validate org
 * existence, so it never errored — it would just silently never match any
 * real knowledge item once agents populated the DB (see the same bug, but
 * caught immediately via a 404, in app/glossary/page.tsx). */
async function resolveDefaultOrgId(): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/v1/orgs/default`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const org = (await res.json()) as { id: string; name: string };
  return org.id;
}

function EvidenceChipPill({ chip }: { chip: EvidenceChip }) {
  return (
    <button
      type="button"
      title={`${chip.meeting_title} — ${chip.speaker} @ ${Math.floor(chip.timestamp_s / 60)}:${(chip.timestamp_s % 60)
        .toString()
        .padStart(2, "0")}`}
      className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 transition"
    >
      {chip.keyframe_thumbnail_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={chip.keyframe_thumbnail_url} alt="" className="h-4 w-6 rounded-sm object-cover" />
      )}
      {chip.label}
    </button>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);

  useEffect(() => {
    resolveDefaultOrgId()
      .then(setOrgId)
      .catch(() => setBackendConnected(false));
  }, []);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || sending) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: question,
      created_at: new Date().toISOString(),
    };
    const history = [...messages, userMessage];
    setMessages(history);
    setInput("");
    setSending(true);

    try {
      const resolvedOrgId = orgId ?? (await resolveDefaultOrgId());
      const requestBody: ChatRequest = {
        org_id: resolvedOrgId,
        question,
        history: messages,
      };
      const res = await fetch(`${API_BASE_URL}/api/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

      const data = (await res.json()) as ChatResponse;
      setBackendConnected(true);
      setMessages((prev) => [...prev, data.message]);
    } catch {
      setBackendConnected(false);
      // Offline fallback only -- the real call above already happened and
      // failed (backend unreachable). See lib/mock-data.ts's own docstring.
      setMessages((prev) => [...prev, mockAssistantReply(question)]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)] max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Org memory chat</h1>
        <p className="mt-1 text-sm text-slate-600">
          Ask across your organization&apos;s meeting history. Every claim should cite evidence.
        </p>
        {backendConnected === false && (
          <p className="mt-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            Not connected to the chat API yet (POST {API_BASE_URL}/api/v1/chat unavailable). Showing a
            demo response instead — see lib/mock-data.ts.
          </p>
        )}
      </div>

      <div className="mt-4 flex-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 space-y-4">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400 text-center mt-8">
            Try: &ldquo;why are we using MongoDB?&rdquo; or &ldquo;what did we commit to last week?&rdquo;
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                m.role === "user"
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-800"
              }`}
            >
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.evidence && m.evidence.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.evidence.map((chip) => (
                    <EvidenceChipPill key={chip.id} chip={chip} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && <p className="text-xs text-slate-400">Thinking…</p>}
      </div>

      <form onSubmit={sendMessage} className="mt-4 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about your meetings…"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
