"use client";

// Ported from the Claude Design project "Visualsprint core development" ->
// Chat.dc.html. AppSidebar isn't re-embedded (see report/page.tsx's note --
// lib/AppShell.tsx already provides it). The mockup's left "Org memory"
// column shows hardcoded past-thread rows; this app has no thread-history
// API to back that with, so it's kept honest here -- just the one real
// piece of functionality (starting a new question), no invented history.

import { useState } from "react";
import { API_BASE_URL } from "@/lib/config";
import { useAuth } from "@/lib/AuthProvider";
import { mockAssistantReply } from "@/lib/mock-data";
import type { ChatMessage, ChatRequest, ChatResponse, EvidenceChip } from "@/lib/types";

const sans = "'IBM Plex Sans', sans-serif";
const serif = "'Source Serif 4', serif";
const mono = "'IBM Plex Mono', monospace";

const SUGGESTIONS = ["Prep me for tomorrow's next meeting", "What's still unresolved from last week?"];

function timestampLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function CiteCard({ chip, n }: { chip: EvidenceChip; n: number }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 9, padding: "12px 14px", width: 216 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <p style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: "var(--text-faint)", margin: "0 0 6px" }}>
          [{n}] {chip.speaker} · {timestampLabel(chip.timestamp_s)}
        </p>
      </div>
      {chip.keyframe_thumbnail_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={chip.keyframe_thumbnail_url}
          alt=""
          style={{ width: "100%", height: 38, background: "#232830", borderRadius: 5, objectFit: "cover", marginBottom: 8 }}
        />
      )}
      <p style={{ fontSize: 11, color: "var(--text-faint)", margin: 0, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
        {chip.meeting_title}
      </p>
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: "50%",
          background: isUser ? "var(--text-muted)" : "var(--accent)",
          color: "#fff",
          fontFamily: mono,
          fontSize: 11,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {isUser ? "Me" : "VS"}
      </div>
      {isUser ? (
        <div style={{ background: "var(--surface2)", borderRadius: 10, padding: "11px 15px", fontSize: 14, color: "var(--text)" }}>
          {message.content}
        </div>
      ) : (
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 14.5, lineHeight: 1.65, color: "var(--text)", margin: "0 0 14px", whiteSpace: "pre-wrap" }}>
            {message.content}
          </p>
          {message.evidence && message.evidence.length > 0 && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {message.evidence.map((chip, i) => (
                <CiteCard key={chip.id} chip={chip} n={i + 1} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ChatPage() {
  const { me, authedFetch } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || sending || !me) return;

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
      const requestBody: ChatRequest = { org_id: me.org.id, question, history: messages };
      const res = await authedFetch(`/api/v1/chat`, {
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
      setMessages((prev) => [...prev, mockAssistantReply(question)]);
    } finally {
      setSending(false);
    }
  }

  const latestUserQuestion = [...messages].reverse().find((m) => m.role === "user")?.content;

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div style={{ width: 260, flexShrink: 0, borderRight: "1px solid var(--border)", padding: "22px 16px" }}>
        <p style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-faint)", margin: "0 0 14px" }}>
          Org memory
        </p>
        <button
          type="button"
          onClick={() => {
            setMessages([]);
            setInput("");
            setBackendConnected(null);
          }}
          style={{
            fontFamily: sans,
            width: "100%",
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--accent-strong)",
            background: "var(--accent-bg)",
            border: "1px solid var(--accent)",
            padding: 9,
            borderRadius: 7,
            cursor: "pointer",
            marginBottom: 16,
          }}
        >
          + New question
        </button>
        {messages.length > 0 && (
          <div style={{ padding: "11px 12px", borderRadius: 8, background: "var(--surface2)" }}>
            <p style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", margin: 0, lineHeight: 1.4 }}>
              {latestUserQuestion}
            </p>
            <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "4px 0 0" }}>Current conversation</p>
          </div>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100vh" }}>
        <header style={{ padding: "20px 32px", borderBottom: "1px solid var(--border)" }}>
          <p style={{ fontFamily: serif, fontSize: 19, color: "var(--text)", margin: 0 }}>
            {latestUserQuestion ?? "Org memory chat"}
          </p>
          <p style={{ fontSize: 12.5, color: "var(--text-faint)", margin: "6px 0 0" }}>
            {latestUserQuestion
              ? "Ask across your organization's meeting history"
              : "Every claim cites a speaker, a transcript span, and a screen"}
          </p>
          {backendConnected === false && (
            <p
              style={{
                marginTop: 8,
                borderRadius: 6,
                background: "var(--evidence-bg)",
                border: "1px solid var(--evidence)",
                padding: "8px 12px",
                fontSize: 12,
                color: "var(--evidence)",
              }}
            >
              Not connected to the chat API yet (POST {API_BASE_URL}/api/v1/chat unavailable). Showing a demo
              response instead.
            </p>
          )}
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: "26px 32px", display: "flex", flexDirection: "column", gap: 22, maxWidth: 760 }}>
          {messages.length === 0 && (
            <p style={{ fontSize: 14, color: "var(--text-faint)", textAlign: "center", marginTop: 32 }}>
              Try: &quot;why are we using MongoDB?&quot; or &quot;what did we commit to last week?&quot;
            </p>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} />
          ))}
          {sending && <p style={{ fontSize: 12.5, color: "var(--text-faint)" }}>Thinking…</p>}
        </div>

        <div style={{ padding: "0 32px", display: "flex", gap: 8 }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setInput(s)}
              style={{
                fontFamily: sans,
                fontSize: 12.5,
                fontWeight: 500,
                color: "var(--text-muted)",
                background: "var(--surface2)",
                border: "1px solid var(--border)",
                padding: "7px 12px",
                borderRadius: 20,
                cursor: "pointer",
              }}
            >
              {s}
            </button>
          ))}
        </div>

        <form onSubmit={sendMessage} style={{ padding: "16px 32px 24px", display: "flex", gap: 10 }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything about your meetings..."
            style={{
              fontFamily: sans,
              flex: 1,
              fontSize: 14,
              padding: "12px 16px",
              borderRadius: 9,
              border: "1px solid var(--border-strong)",
              background: "var(--surface)",
              color: "var(--text)",
            }}
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            style={{
              fontFamily: sans,
              fontSize: 13.5,
              fontWeight: 600,
              color: "#fff",
              background: "var(--accent-strong)",
              border: "none",
              padding: "0 22px",
              borderRadius: 9,
              cursor: sending || !input.trim() ? "default" : "pointer",
              opacity: sending || !input.trim() ? 0.6 : 1,
            }}
          >
            Ask
          </button>
        </form>
      </div>
    </div>
  );
}
