import { useEffect, useRef, useState } from "react";
import { Api, ApiError, errorMessage } from "./api.js";
import { externalTaskStatus, workflowOperation } from "./workflow-model.js";
import { z } from "zod";
type Props = { api: Api; path: string; operation: z.infer<typeof workflowOperation> };
export function ExternalTaskStatus(props: Props) {
  return (
    <TaskStatus
      key={`${props.path}:${props.operation.id}:${props.operation.externalId ?? ""}`}
      {...props}
    />
  );
}
function TaskStatus({ api, path, operation }: Props) {
  const [status, setStatus] = useState<z.infer<typeof externalTaskStatus>>(),
    [observedAt, setObservedAt] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const abort = useRef(new AbortController());
  useEffect(() => {
    const current = new AbortController();
    abort.current = current;
    return () => current.abort();
  }, [api]);
  async function check() {
    if (busy || operation.state !== "confirmed" || !operation.externalId) return;
    const signal = abort.current.signal;
    setBusy(true);
    setStatus(undefined);
    setObservedAt("");
    setError("");
    try {
      const before = await api.request(`${path}/operations/${operation.id}`, workflowOperation, {
        signal,
      });
      if (
        before.id !== operation.id ||
        before.actionId !== operation.actionId ||
        before.state !== "confirmed" ||
        before.externalId !== operation.externalId
      )
        throw new ApiError("TASK_STATUS_CHANGED", 409);
      const value = await api.request(
        `${path}/action-executions/${operation.id}/task-status`,
        externalTaskStatus,
        { signal },
      );
      if (value.operationId !== operation.id || value.externalId !== operation.externalId)
        throw new ApiError("TASK_STATUS_CHANGED", 409);
      const after = await api.request(`${path}/operations/${operation.id}`, workflowOperation, {
        signal,
      });
      if (
        after.id !== before.id ||
        after.state !== "confirmed" ||
        after.externalId !== before.externalId ||
        after.version !== before.version
      )
        throw new ApiError("TASK_STATUS_CHANGED", 409);
      if (!signal.aborted) {
        setStatus(value);
        setObservedAt(new Date().toISOString());
      }
    } catch (cause) {
      if (!signal.aborted) {
        setStatus(undefined);
        setError(errorMessage(cause));
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="External task status">
      <h4>Provider-reported task status</h4>
      <p>
        Confirmed creation is not confirmed completion. Status is fetched only when you request it;
        it does not mark the human commitment completed.
      </p>
      <button
        type="button"
        disabled={busy || operation.state !== "confirmed" || !operation.externalId}
        onClick={() => void check()}
      >
        {busy ? "Checking provider…" : "Check external task status"}
      </button>
      {status ? (
        <>
          <p role="status">
            {status.status} · provider state {status.state} · reference {status.externalId}.
          </p>
          <p>
            Provider updated: {status.updatedAt || "unknown"}. Observed by VisualSprint:{" "}
            {observedAt}. This is a snapshot, not continuous verification.
          </p>
        </>
      ) : (
        <p>No current provider status has been checked.</p>
      )}
      {error ? <p role="alert">{error} No stale provider status is retained.</p> : null}
    </section>
  );
}
