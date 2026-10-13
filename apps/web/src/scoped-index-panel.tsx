import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { Api, ApiError, errorMessage } from "./api.js";
import { useCommand } from "./ui.js";
export type IndexScope = {
  kind: "meeting" | "project" | "customer" | "workspace";
  id: string | null;
};
export type IndexReadiness = { scope: IndexScope; ready: boolean };
const indexScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), id: z.null() }),
  z.object({ kind: z.enum(["meeting", "project", "customer"]), id }),
]);
export const indexJobSchema = z
  .object({
    id,
    scope: indexScope,
    status: z.enum(["queued", "running", "complete", "failed"]),
    cursor: z.number().int().nonnegative(),
    totalChunks: z.number().int().nonnegative(),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
  })
  .refine(
    (v) => v.cursor <= v.totalChunks && (v.status !== "complete" || v.cursor === v.totalChunks),
    "Invalid index progress",
  );
type Props = {
  api: Api;
  workspaceId: string;
  scope: IndexScope;
  onReadiness?: (state: IndexReadiness) => void;
};
function storedJob(key: string) {
  try {
    const value = sessionStorage.getItem(key);
    const parsed = id.safeParse(value);
    return parsed.success ? parsed.data : "";
  } catch {
    return "";
  }
}
function rememberJob(key: string, value: string) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* Never persist transcript content; opaque ID persistence is optional. */
  }
}
export function ScopedIndexPanel(props: Props) {
  return (
    <IndexPanel key={`${props.workspaceId}:${props.scope.kind}:${props.scope.id}`} {...props} />
  );
}
function IndexPanel({ api, workspaceId, scope, onReadiness }: Props) {
  const storageKey = `visualsprint:index:${workspaceId}:${scope.kind}:${scope.id ?? ""}`;
  const [jobId, setJobId] = useState(() => storedJob(storageKey));
  const [job, setJob] = useState<z.infer<typeof indexJobSchema>>(),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const command = useCommand(),
    abort = useRef(new AbortController()),
    base = `${api.scope(workspaceId)}/intelligence`;
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => controller.abort();
  }, [api]);
  useEffect(() => {
    if (!jobId) {
      onReadiness?.({ scope, ready: false });
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const current = await api.request(`${base}/indexes/${jobId}`, indexJobSchema, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (
          current.id !== jobId ||
          current.scope.kind !== scope.kind ||
          current.scope.id !== scope.id
        )
          throw new Error("INDEX_JOB_MISMATCH");
        setJob(current);
        setError("");
        onReadiness?.({ scope, ready: current.status === "complete" });
        if (["queued", "running", "complete"].includes(current.status))
          timer = setTimeout(() => void poll(), current.status === "complete" ? 10000 : 2000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setJob(undefined);
        onReadiness?.({ scope, ready: false });
        setError(
          cause instanceof ApiError && cause.code === "RETRIEVAL_DISABLED"
            ? "Indexed retrieval is not enabled by the administrator; no embedding call or fallback index was started."
            : errorMessage(cause),
        );
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          setJobId("");
          rememberJob(storageKey, "");
        }
      }
    };
    setJob(undefined);
    onReadiness?.({ scope, ready: false });
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, base, jobId, scope.kind, scope.id, retry, storageKey, onReadiness]);
  return (
    <section className="panel" aria-label="Scoped retrieval index">
      <h3>Optional indexed retrieval</h3>
      <p>
        Build an index only for this {scope.kind} scope using finalized transcript text you can
        currently read. Embeddings use the configured model quota and may incur charges. This does
        not capture meetings, grant access or approve actions.
      </p>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          disabled={command.busy || Boolean(jobId)}
        />
        I choose to build this scoped text index using the configured embedding provider.
      </label>
      <button
        type="button"
        disabled={!confirmed || command.busy || Boolean(jobId)}
        onClick={() =>
          void command.run(
            { scope },
            (key) =>
              api.request(`${base}/indexes`, indexJobSchema, {
                method: "POST",
                body: { scope },
                key,
                signal: abort.current.signal,
              }),
            (value) => {
              setJobId(value.id);
              rememberJob(storageKey, value.id);
              setConfirmed(false);
            },
          )
        }
      >
        {command.busy ? "Queuing index…" : "Build scoped index"}
      </button>
      {command.error ? (
        <p role="alert">
          {command.error instanceof ApiError && command.error.code === "RETRIEVAL_DISABLED"
            ? "Indexed retrieval is not enabled by the administrator; no embedding call or fallback index was started."
            : errorMessage(command.error)}{" "}
          Retry the same command if acknowledgement was lost, not a replacement build.
        </p>
      ) : null}
      {error ? (
        <p role="alert">{error} Readiness is unconfirmed; indexed answers remain disabled.</p>
      ) : null}
      {jobId ? (
        <>
          <p>Index operation: {jobId}. A queued index is not ready for answers.</p>
          <button type="button" onClick={() => setRetry((v) => v + 1)}>
            Refresh existing index
          </button>
        </>
      ) : null}
      {job ? (
        <article aria-label="Index progress">
          <p role="status">
            {job.status} · {job.cursor}/{job.totalChunks} chunks
            {job.errorCode ? ` · ${job.errorCode}` : ""}
          </p>
          {job.status === "complete" ? (
            <p>
              The index is ready for this authorized source fingerprint. Answers still recheck
              source revisions and permissions before publication. An embedding match does not
              verify a generated claim.
            </p>
          ) : null}
          {job.errorCode === "SOURCE_CHANGED" ? (
            <p>
              Source revisions or access changed. This index cannot authorize an indexed answer;
              review this scope and explicitly rebuild.
            </p>
          ) : null}
          {job.status === "failed" ? (
            <p>
              Index build is incomplete. No indexed-to-lexical fallback is performed automatically.
            </p>
          ) : null}
        </article>
      ) : null}
      {job?.status === "failed" ? (
        <button
          type="button"
          onClick={() => {
            setJobId("");
            setJob(undefined);
            setConfirmed(false);
            rememberJob(storageKey, "");
            onReadiness?.({ scope, ready: false });
          }}
        >
          Review scope for a new index
        </button>
      ) : null}
    </section>
  );
}
