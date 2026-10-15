import { useEffect, useState } from "react";
import { z } from "zod";
import { Api, errorMessage, type Meeting } from "./api.js";
import { Feedback, Form, useCommand, useData } from "./ui.js";
import { CommitmentActionDraft } from "./commitment-action-draft.js";
import { ExternalTaskStatus } from "./external-task-status.js";
import {
  actionDraft,
  reviewedAction,
  workflowOperation,
  operationMessage,
  acceptedActionCommitment,
} from "./workflow-model.js";
export function WorkflowPanel({
  api,
  workspaceId,
  meeting,
  owner,
}: {
  api: Api;
  workspaceId: string;
  meeting: Meeting;
  owner: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const path = api.scope(workspaceId);
  const [actions, setActions] = useState<{
    value?: z.infer<typeof reviewedAction>[];
    error?: unknown;
    loading: boolean;
  }>({ loading: true });
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setActions({ loading: true });
    if (!owner) {
      setActions({ value: [], loading: false });
      return () => abort.abort();
    }
    async function poll() {
      try {
        const value = await api.request(
          `${path}/actions?meetingId=${meeting.id}`,
          z.array(reviewedAction).max(100),
          { signal: abort.signal },
        );
        if (!abort.signal.aborted) setActions({ value, loading: false });
      } catch (error) {
        if (!abort.signal.aborted) setActions({ error, loading: false });
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 5000);
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, path, meeting.id, owner, revision]);
  if (!owner) return null;
  return (
    <section aria-label="Approved meeting actions" className="panel">
      <h2>Reviewed follow-through</h2>
      <p>
        Review the exact text, destination and source revision before approving. Approval and
        execution are separate steps. Connector setup is required; this does not confirm a task
        exists.
      </p>
      <Feedback data={actions} />
      <button type="button" onClick={() => setRevision((value) => value + 1)}>
        Refresh reviewed actions
      </button>
      {actions.value ? (
        <>
          <CommitmentActionDraft
            key={`${workspaceId}:${meeting.id}:${meeting.version}`}
            api={api}
            path={path}
            meeting={meeting}
            changed={() => setRevision((value) => value + 1)}
          />
          <Draft
            api={api}
            path={path}
            meeting={meeting}
            changed={() => setRevision((value) => value + 1)}
          />
        </>
      ) : null}
      {actions.value
        ?.filter((action) => action.input.source.meetingId === meeting.id)
        .map((action) => (
          <Review
            key={action.id + ":" + action.version}
            api={api}
            path={path}
            meeting={meeting}
            action={action}
            changed={() => setRevision((value) => value + 1)}
          />
        ))}
    </section>
  );
}
function Draft({
  api,
  path,
  meeting,
  changed,
}: {
  api: Api;
  path: string;
  meeting: Meeting;
  changed: () => void;
}) {
  const command = useCommand();
  const [provider, setProvider] = useState<"jira" | "github" | "linear">("jira");
  const [connectionId, setConnection] = useState("");
  const [destination, setDestination] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const input = {
    connectionId,
    provider,
    destination,
    payload: { title, description, dueDate: null },
    source: { meetingId: meeting.id, revision: meeting.version },
  };
  return (
    <Form
      title="Propose a task"
      button="Save draft (does not execute)"
      command={command}
      submit={() =>
        void command.run(
          input,
          async (key) => {
            const validated = actionDraft.parse(input);
            return api.request(`${path}/actions`, reviewedAction, {
              method: "POST",
              key,
              body: validated,
            });
          },
          () => {
            setTitle("");
            setDescription("");
            changed();
          },
        )
      }
    >
      <label>
        Connector
        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value as typeof provider)}
        >
          <option value="jira">Jira</option>
          <option value="github">GitHub</option>
          <option value="linear">Linear</option>
        </select>
      </label>
      <label>
        Configured connector ID
        <input
          required
          value={connectionId}
          onChange={(event) => setConnection(event.target.value)}
          placeholder="Connection UUID from administrator setup"
        />
      </label>
      <label>
        Destination
        <input
          required
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          placeholder="Project, repository or team"
        />
      </label>
      <label>
        Task title
        <input
          required
          maxLength={250}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        Exact task description
        <textarea
          maxLength={12000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <p>
        Source meeting revision: {meeting.version}. No AI output grants external-write permission.
      </p>
    </Form>
  );
}
function Review({
  api,
  path,
  meeting,
  action,
  changed,
}: {
  api: Api;
  path: string;
  meeting: Meeting;
  action: z.infer<typeof reviewedAction>;
  changed: () => void;
}) {
  const approve = useCommand(),
    execute = useCommand(),
    revoke = useCommand();
  const [confirmed, setConfirmed] = useState(false);
  const [operation, setOperation] = useState<z.infer<typeof workflowOperation>>();
  const [loadingOperation, setLoadingOperation] = useState(true);
  const [error, setError] = useState("");
  const linked = action.input.source.commitment;
  const [sourceRevision, setSourceRevision] = useState(0);
  const source = useData(
    (signal) =>
      linked
        ? api.request(`${path}/commitments/${linked.id}`, acceptedActionCommitment, { signal })
        : Promise.resolve(null),
    [api, path, linked?.id, linked?.version, sourceRevision],
  );
  useEffect(() => {
    if (!linked) return;
    const timer = setInterval(() => setSourceRevision((value) => value + 1), 5000);
    return () => clearInterval(timer);
  }, [linked?.id]);
  const sourceBlocked =
    !!linked &&
    (source.loading ||
      !!source.error ||
      !source.value ||
      source.value.id !== linked.id ||
      source.value.meetingId !== meeting.id ||
      source.value.version !== linked.version ||
      source.value.state !== "open" ||
      source.value.evidenceStatus !== "current");
  const stale = action.input.source.revision !== meeting.version;
  useEffect(() => {
    const abort = new AbortController();
    setLoadingOperation(true);
    void api
      .request(`${path}/actions/${action.id}/operations`, z.array(workflowOperation), {
        signal: abort.signal,
      })
      .then(
        (values) => {
          if (!abort.signal.aborted) {
            setOperation(values[0]);
            setLoadingOperation(false);
          }
        },
        (cause) => {
          if (!abort.signal.aborted) {
            setError(errorMessage(cause));
            setLoadingOperation(false);
          }
        },
      );
    return () => abort.abort();
  }, [api, path, action.id]);
  useEffect(() => {
    if (!operation || ["confirmed", "rejected", "cancelled"].includes(operation.state)) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const latest = await api.request(`${path}/operations/${operation.id}`, workflowOperation, {
          signal: abort.signal,
        });
        if (latest.id !== operation.id || latest.actionId !== action.id)
          throw new Error("Operation target changed.");
        if (!abort.signal.aborted) {
          setOperation(latest);
          setError("");
          timer = setTimeout(() => void poll(), 2000);
        }
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError(errorMessage(cause));
          timer = setTimeout(() => void poll(), 5000);
        }
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, path, operation?.id, operation?.state]);
  return (
    <article className="panel">
      <h3>{action.input.payload.title}</h3>
      <p>
        State: {action.state}; version {action.version}. Connector {action.input.provider};
        destination {action.input.destination}; connection {action.input.connectionId}.
      </p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{action.input.payload.description}</pre>
      <p>Exact due date: {action.input.payload.dueDate ?? "none"}.</p>
      <p>
        Source revision {action.input.source.revision}; approval fingerprint {action.payloadHash}.
      </p>
      {linked ? (
        <p>
          Accepted commitment {linked.id}, revision {linked.version}. Human status and external task
          status are separate.
        </p>
      ) : null}
      {sourceBlocked ? (
        <p role="alert">
          The accepted source is loading, unavailable, changed or no longer open. Refresh and review
          it before any approval or execution; no replacement task is created automatically.
        </p>
      ) : null}
      {stale ? (
        <p role="alert">
          The meeting changed. This draft needs review against the current revision before
          execution.
        </p>
      ) : null}
      {action.state !== "approved" ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={stale || sourceBlocked || approve.busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I approve this exact destination and task text.
          </label>
          <Form
            title="Approve exact payload"
            button="Approve reviewed task"
            command={approve}
            disabled={stale || sourceBlocked || !confirmed}
            submit={() =>
              void approve.run(
                { id: action.id, expectedVersion: action.version, confirmed: true },
                (key) =>
                  api.request(`${path}/actions/${action.id}/approve`, reviewedAction, {
                    method: "POST",
                    key,
                    body: { expectedVersion: action.version, confirmed: true },
                  }),
                changed,
              )
            }
          >
            <p>Approval is disabled until you confirm the exact payload above.</p>
          </Form>
        </>
      ) : (
        <>
          <Form
            title="Execute approved task"
            button="Queue external task creation"
            command={execute}
            disabled={
              stale || sourceBlocked || loadingOperation || Boolean(operation) || Boolean(error)
            }
            submit={() =>
              void execute.run(
                { id: action.id, expectedVersion: action.version },
                (key) =>
                  api.request(`${path}/actions/${action.id}/execute`, workflowOperation, {
                    method: "POST",
                    key,
                    body: { expectedVersion: action.version },
                  }),
                setOperation,
              )
            }
          >
            <p>
              This command is idempotent. An uncertain response must not cause a duplicate task.
            </p>
          </Form>
          <Form
            title="Withdraw approval"
            button="Revoke approval"
            command={revoke}
            submit={() =>
              void revoke.run(
                { id: action.id, expectedVersion: action.version },
                (key) =>
                  api.request(`${path}/actions/${action.id}/revoke`, reviewedAction, {
                    method: "POST",
                    key,
                    body: { expectedVersion: action.version },
                  }),
                changed,
              )
            }
          >
            <p>Revocation prevents new writes; it cannot undo an already-created external task.</p>
          </Form>
        </>
      )}
      {operation ? (
        <p role="status">
          {operationMessage(operation.state)}{" "}
          {operation.externalId ? `Reference: ${operation.externalId}` : ""}{" "}
          {operation.errorCode ? `Code: ${operation.errorCode}` : ""}
        </p>
      ) : null}
      {operation?.state === "confirmed" && operation.externalId ? (
        <ExternalTaskStatus api={api} path={path} operation={operation} />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </article>
  );
}
