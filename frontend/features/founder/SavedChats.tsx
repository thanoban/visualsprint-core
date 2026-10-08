"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { apiJson, workspacePath } from "@/lib/founder-api";
import { useWorkspaceData } from "./useWorkspaceData";

interface Thread { id: string; title: string; status: string; version: number }
interface Message { id: string; role: string; state: string; content: string; citations: { meeting_id: string; knowledge_item_id: string }[] }

function Conversation({ thread }: { thread: Thread }) {
  const { me, authedFetch } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const [intent, setIntent] = useState<{ text: string; id: string } | null>(null);
  const org = me?.org.id;
  useEffect(() => {
    if (!org) return;
    const controller = new AbortController();
    const load = () => apiJson<Message[]>(authedFetch, workspacePath(org, `/threads/${thread.id}/messages${cursor ? `?before_id=${encodeURIComponent(cursor)}` : ""}`), { signal: controller.signal })
      .then((rows) => { if (!controller.signal.aborted) { setMessages(rows); setError(""); } })
      .catch((reason: unknown) => { if (!controller.signal.aborted) { setMessages([]); setError(reason instanceof Error ? reason.message : "Unable to restore conversation"); } });
    void load();
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [org, thread.id, cursor, revision, authedFetch]);
  async function send() {
    if (!org || busy || !text.trim()) return;
    const id = intent?.text === text ? intent.id : crypto.randomUUID();
    setIntent({ text, id }); setBusy(true); setError("");
    try { await apiJson(authedFetch, workspacePath(org, `/threads/${thread.id}/messages`), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, client_request_id: id }),
    }); setText(""); setIntent(null); setCursors([]); setMessages([]); setRevision((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to send message"); }
    finally { setBusy(false); }
  }
  async function retry(messageId: string) {
    if (!org || busy) return;
    setBusy(true);
    try { await apiJson(authedFetch, workspacePath(org, `/threads/${thread.id}/messages/${messageId}/retry`), { method: "POST" }); setRevision((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to retry answer"); }
    finally { setBusy(false); }
  }
  const generating = messages.some((m) => ["pending", "generating"].includes(m.state));
  const oldestId = messages[0]?.id;
  return <div><p>Private conversation. Answers use verified meeting evidence, with bounded retrieval and current source access.</p>
    {messages.length === 100 && oldestId && <button disabled={busy} onClick={() => { setCursors((values) => [...values, oldestId]); setMessages([]); }}>Older messages</button>}
    {cursor && <button disabled={busy} onClick={() => { setCursors((values) => values.slice(0, -1)); setMessages([]); }}>Newer messages</button>}
    <div aria-live="polite">{messages.map((message) => <article key={message.id} className="founder-card">
      <h4>{message.role === "user" ? "You" : "VisualSprint"} · {message.state}</h4>
      <p style={{ whiteSpace: "pre-wrap" }}>{message.content || "Waiting for the answer worker…"}</p>
      {message.role === "assistant" && message.state === "failed" && <button disabled={busy || thread.status !== "active"} onClick={() => { void retry(message.id); }}>Retry answer</button>}
      {message.citations?.map((source, index) => <p key={`${source.knowledge_item_id}:${index}`}><Link href={`/meetings/${source.meeting_id}/report`}>Source {index + 1}: open meeting report</Link></p>)}
    </article>)}</div>
    {error && <p role="alert" className="founder-error">{error}</p>}
    <label htmlFor="saved-chat-question">Ask about this project or customer</label>
    <textarea id="saved-chat-question" value={text} maxLength={8192} onChange={(e) => setText(e.target.value)} disabled={thread.status !== "active" || busy} />
    <button disabled={busy || generating || !text.trim() || thread.status !== "active"} onClick={() => { void send(); }}>Send</button>
    {generating && <p role="status">Answer pending. The separately running chat worker processes this request.</p>}
    {thread.status !== "active" && <p>This conversation is archived.</p>}
  </div>;
}

function Chats({ kind, id }: { kind: "project" | "customer"; id: string }) {
  const { me, authedFetch } = useAuth();
  const router = useRouter(); const pathname = usePathname(); const query = useSearchParams();
  const threads = useWorkspaceData<Thread[]>(`/threads?scope_kind=${kind}&scope_id=${encodeURIComponent(id)}`);
  const [title, setTitle] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const selected = threads.data?.find((thread) => thread.id === query.get("thread"));
  function select(threadId: string) { const params = new URLSearchParams(query.toString()); params.set("thread", threadId); router.replace(`${pathname}?${params.toString()}`, { scroll: false }); }
  async function mutate(thread?: Thread, archive = false) {
    if (!me || busy) return;
    setBusy(true); setError("");
    try { const value = await apiJson<Thread>(authedFetch, workspacePath(me.org.id, thread ? `/threads/${thread.id}` : "/threads"), {
      method: thread ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(thread ? { version: thread.version, ...(archive ? { status: thread.status === "active" ? "archived" : "active" } : { title }) } : { scope_kind: kind, scope_id: id, title }),
    }); setTitle(""); threads.refresh(); select(value.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save conversation"); }
    finally { setBusy(false); }
  }
  return <section><h2>Saved chats</h2><label htmlFor="saved-chat-title">Conversation title</label>
    <input id="saved-chat-title" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} />
    <button disabled={busy} onClick={() => { void mutate(); }}>New chat</button>
    {selected && <><button disabled={busy || !title.trim()} onClick={() => { void mutate(selected); }}>Rename selected</button>
      <button disabled={busy} onClick={() => { void mutate(selected, true); }}>{selected.status === "active" ? "Archive" : "Restore"}</button></>}
    {threads.data?.length === 0 && <p>No saved conversations yet.</p>}
    <ul>{threads.data?.map((thread) => <li key={thread.id}><button disabled={busy} aria-pressed={selected?.id === thread.id} onClick={() => select(thread.id)}>{thread.title || "Untitled chat"} · {thread.status}</button></li>)}</ul>
    {(error || threads.error) && <p role="alert" className="founder-error">{error || threads.error}</p>}
    {selected && <Conversation key={`${me?.user.id}:${me?.org.id}:${selected.id}`} thread={selected} />}
  </section>;
}

export function SavedChats(props: { kind: "project" | "customer"; id: string }) {
  return <Suspense fallback={<p>Loading conversations…</p>}><Chats {...props} /></Suspense>;
}
