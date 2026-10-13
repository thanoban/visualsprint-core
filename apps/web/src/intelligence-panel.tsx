import { useEffect, useState } from "react";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { Api, errorMessage } from "./api.js";
import { Feedback, Form, useCommand, useData } from "./ui.js";

const scopeSchema = z.object({
  kind: z.enum(["meeting", "project", "customer", "workspace"]),
  id: id.nullable(),
});
export type ChatScope = z.infer<typeof scopeSchema>;
const claim = z.object({
  kind: z.enum(["discussion", "decision", "commitment"]),
  text: z.string(),
  citation: z.object({ meetingId: id, captureId: id, segmentId: id, revision: z.number().int() }),
});
const result = z.object({
  claims: z.array(claim),
  partial: z.boolean(),
  unsupported: z.boolean(),
  reviewRequired: z.literal(true),
});
const jobSchema = z.object({
  id,
  kind: z.enum(["summary", "answer"]),
  threadId: id.nullable(),
  question: z.string().nullable(),
  status: z.enum(["queued", "running", "complete", "failed", "invalidated"]),
  result: result.nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
});
type Job = z.infer<typeof jobSchema>;
const threadSchema = z.object({
  id,
  title: z.string(),
  scope: scopeSchema,
  version: z.number().int(),
});
const historySchema = z.object({ thread: threadSchema, messages: z.array(jobSchema) });
const pending = (job: Job) => job.status === "queued" || job.status === "running";
function Output({ job, workspaceId }: { job: Job; workspaceId: string }) {
  return (
    <article
      className="panel"
      aria-label={job.kind === "answer" ? "Saved chat answer" : "Meeting summary"}
    >
      {job.question ? <h4>{job.question}</h4> : null}
      <p role="status">
        {job.status.replaceAll("_", " ")}
        {job.errorCode ? ` — ${job.errorCode}` : ""}
      </p>
      {job.status === "invalidated" ? (
        <p>
          Source evidence or access changed. This answer was removed; request a new answer using the
          current evidence.
        </p>
      ) : null}
      {job.result ? (
        <>
          {job.result.partial ? (
            <p role="status">
              Partial evidence: some meetings have capture gaps or no finalized transcript. Missing
              speech has not been invented.
            </p>
          ) : null}
          <p>
            Evidence excerpts only. Decisions and commitments are proposals that require review, not
            approved actions.
          </p>
          {job.result.unsupported ? <p>No supported evidence was found for this request.</p> : null}
          <ul>
            {job.result.claims.map((item, index) => (
              <li key={`${item.citation.segmentId}:${index}`}>
                <span>{item.kind}: </span>
                <q>{item.text}</q>
                <p>
                  <a href={`/w/${workspaceId}?meetingId=${item.citation.meetingId}`}>
                    Open source meeting
                  </a>{" "}
                  · segment {item.citation.segmentId} · revision {item.citation.revision}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </article>
  );
}
export function IntelligencePanel({
  api,
  workspaceId,
  scope,
  contexts = [],
}: {
  api: Api;
  workspaceId: string;
  scope: ChatScope;
  contexts?: { label: string; scope: ChatScope }[];
}) {
  const [selectedScope, setScope] = useState(scope),
    [threadId, setThreadId] = useState(""),
    [title, setTitle] = useState(""),
    [question, setQuestion] = useState(""),
    [revision, setRevision] = useState(0),
    [error, setError] = useState("");
  const create = useCommand(),
    send = useCommand(),
    summary = useCommand();
  const base = `${api.scope(workspaceId)}/intelligence`;
  useEffect(() => {
    setScope(scope);
    setThreadId("");
    setError("");
    setQuestion("");
  }, [workspaceId, scope.kind, scope.id]);
  const threads = useData(
    (signal) => api.request(`${base}/chats`, z.array(threadSchema), { signal }),
    [api, base, revision],
  );
  const history = useData(
    async (signal) =>
      threadId
        ? api.request(`${base}/chats/${threadId}/messages`, historySchema, { signal })
        : undefined,
    [api, base, threadId, revision],
  );
  const summaries = useData(
    async (signal) =>
      selectedScope.kind === "meeting" && selectedScope.id
        ? api.request(`${base}/meetings/${selectedScope.id}/summaries`, z.array(jobSchema), {
            signal,
          })
        : [],
    [api, base, selectedScope.kind, selectedScope.id, revision],
  );
  const active = [...(history.value?.messages ?? []), ...(summaries.value ?? [])].some(pending);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setRevision((value) => value + 1), 2000);
    return () => clearTimeout(timer);
  }, [active, revision]);
  const matching =
    threads.value?.filter(
      (thread) => thread.scope.kind === selectedScope.kind && thread.scope.id === selectedScope.id,
    ) ?? [];
  const choices = [{ label: `Current ${scope.kind}`, scope }, ...contexts];
  return (
    <section aria-label="Meeting intelligence and saved chats">
      <h2>Evidence and saved chats</h2>
      <p>
        Private chats are scoped to meetings you can currently read. Project assignment does not
        share a meeting. Answers are checked again against current access and transcript
        corrections.
      </p>
      {contexts.length ? (
        <label>
          Chat context
          <select
            aria-label="Chat context"
            value={`${selectedScope.kind}:${selectedScope.id ?? ""}`}
            onChange={(event) => {
              const value = choices.find(
                (choice) => `${choice.scope.kind}:${choice.scope.id ?? ""}` === event.target.value,
              );
              if (value) {
                setScope(value.scope);
                setThreadId("");
                setQuestion("");
              }
            }}
          >
            {choices.map((choice, index) => (
              <option key={index} value={`${choice.scope.kind}:${choice.scope.id ?? ""}`}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {selectedScope.kind === "meeting" && selectedScope.id ? (
        <>
          <Form
            title="Review meeting evidence"
            button="Generate summary"
            command={summary}
            submit={() =>
              void summary.run(
                { workspaceId, meetingId: selectedScope.id },
                (key) =>
                  api.request(`${base}/summaries`, jobSchema, {
                    method: "POST",
                    key,
                    body: { meetingId: selectedScope.id },
                  }),
                () => setRevision((value) => value + 1),
              )
            }
          >
            <p>
              Uses finalized English transcript text. Incomplete capture is labelled partial; notes
              are not overwritten.
            </p>
          </Form>
          <Feedback data={summaries} />
          {summaries.value?.at(-1) ? (
            <Output job={summaries.value.at(-1)!} workspaceId={workspaceId} />
          ) : null}
        </>
      ) : null}
      <Feedback data={threads} />
      <label>
        Saved chats
        <select
          aria-label="Saved chats"
          value={threadId}
          onChange={(event) => {
            setThreadId(event.target.value);
            setQuestion("");
          }}
        >
          <option value="">Choose a chat</option>
          {matching.map((thread) => (
            <option value={thread.id} key={thread.id}>
              {thread.title}
            </option>
          ))}
        </select>
      </label>
      <Form
        title={`New ${selectedScope.kind} chat`}
        button="Create chat"
        command={create}
        submit={() =>
          void create.run(
            { workspaceId, title, scope: selectedScope },
            (key) =>
              api.request(`${base}/chats`, threadSchema, {
                method: "POST",
                key,
                body: { title, scope: selectedScope },
              }),
            (thread) => {
              setThreadId(thread.id);
              setTitle("");
              setRevision((value) => value + 1);
            },
          )
        }
      >
        <label>
          Chat title
          <input
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
      </Form>
      {threadId ? (
        <>
          <Feedback data={history} />
          {history.value?.messages.map((job) => (
            <Output key={job.id} job={job} workspaceId={workspaceId} />
          ))}
          <Form
            title="Ask your meeting evidence"
            button="Ask"
            command={send}
            disabled={history.loading || Boolean(history.error) || active}
            submit={() =>
              void send.run(
                { workspaceId, threadId, text: question },
                (key) =>
                  api.request(`${base}/chats/${threadId}/messages`, jobSchema, {
                    method: "POST",
                    key,
                    body: { text: question },
                  }),
                () => {
                  setQuestion("");
                  setRevision((value) => value + 1);
                },
              )
            }
          >
            <label>
              Question
              <textarea
                required
                maxLength={8000}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </label>
          </Form>
        </>
      ) : null}
      <button
        className="secondary"
        onClick={() => {
          setError("");
          setRevision((value) => value + 1);
        }}
      >
        Refresh intelligence
      </button>
    </section>
  );
}
