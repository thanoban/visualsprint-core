import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { Api, ApiError, errorMessage, type Meeting, type Project } from "./api.js";
import { Feedback, useCommand, useData } from "./ui.js";

const scope = z
  .object({ kind: z.enum(["meeting", "project", "customer", "workspace"]), id: id.nullable() })
  .refine((v) => (v.kind === "workspace" ? v.id === null : v.id !== null));
const citation = z.object({
  meetingId: id,
  captureId: id,
  segmentId: id,
  revision: z.number().int().positive(),
});
const reviewed = z.object({
  id,
  meetingId: id,
  version: z.number().int().positive(),
  kind: z.enum(["decision", "commitment"]),
  title: z.string(),
  text: z.string(),
  state: z.string(),
  ownerId: id.nullable(),
  dueDate: z.string().nullable(),
  statusSource: z.literal("human_review"),
  evidenceStatus: z.enum(["current", "changed", "unavailable"]),
  sourcePartial: z.boolean(),
  citations: z.array(citation.omit({ meetingId: true })),
  externalStatus: z.literal("unknown"),
  externalVerifiedAt: z.null(),
});
export const preparationJob = z.object({
  id,
  status: z.enum(["queued", "running", "complete", "failed", "invalidated"]),
  errorCode: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string(),
  result: z
    .object({
      meetingId: id,
      meetingVersion: z.number().int().positive(),
      historyScope: scope,
      sourceFingerprint: z.string(),
      sourceVersions: z.array(
        z.object({
          meetingId: id,
          version: z.number().int().positive(),
          captureId: id.nullable(),
          captureVersion: z.number().int().positive().nullable(),
          coverage: z.enum(["complete", "partial", "unknown"]),
        }),
      ),
      findings: z.array(
        z.object({
          kind: z.enum(["discussion", "decision", "commitment"]),
          text: z.string(),
          citation,
        }),
      ),
      questions: z.array(
        z.object({
          kind: z.enum(["clarification", "commitment"]),
          text: z.string(),
          commitmentId: id,
          commitmentVersion: z.number().int().positive(),
          sourceMeetingId: id,
          statusVerifiedAt: z.string().datetime().nullable(),
        }),
      ),
      reviewedRecords: z.array(reviewed).optional(),
      partial: z.boolean(),
      reviewRequired: z.literal(true),
    })
    .nullable(),
});
type Scope = z.infer<typeof scope>;
type Job = z.infer<typeof preparationJob>;
type Props = {
  api: Api;
  workspaceId: string;
  meeting: Meeting;
  owner: boolean;
  projects: Project[];
};
const remembered = z.object({ jobId: id, historyScope: scope });
function readRemembered(key: string) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 1200) return null;
    const parsed = remembered.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function storeRemembered(key: string, value: z.infer<typeof remembered> | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* Opaque-job persistence is optional; content is never stored here. */
  }
}
export function PreparationPanel(props: Props) {
  return props.owner ? (
    <ScopedPreparation
      key={`${props.workspaceId}:${props.meeting.id}:${props.meeting.version}:${props.meeting.ownerId}`}
      {...props}
    />
  ) : null;
}
function ScopedPreparation({ api, workspaceId, meeting, projects }: Props) {
  const storageKey = `visualsprint:preparation:${workspaceId}:${meeting.id}:${meeting.version}:${meeting.ownerId}`;
  const [saved] = useState(() => readRemembered(storageKey));
  const [selected, setSelected] = useState(
    saved ? `${saved.historyScope.kind}:${saved.historyScope.id ?? ""}` : "",
  );
  const [confirmed, setConfirmed] = useState(false),
    [jobId, setJobId] = useState(saved?.jobId ?? ""),
    [requestedScope, setRequestedScope] = useState<Scope | null>(saved?.historyScope ?? null);
  const [job, setJob] = useState<Job>(),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const command = useCommand(),
    base = `${api.scope(workspaceId)}/intelligence`,
    abort = useRef(new AbortController());
  const contexts = useData(
    async (signal) => ({
      customers: await api.customers(workspaceId, signal),
      meetings: await api.meetings(workspaceId, undefined, signal),
    }),
    [api, workspaceId],
  );
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => controller.abort();
  }, [api]);
  useEffect(() => {
    if (!jobId || !requestedScope) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = await api.request(`${base}/preparations/${jobId}`, preparationJob, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (
          value.id !== jobId ||
          (value.result &&
            (value.result.meetingId !== meeting.id ||
              value.result.meetingVersion !== meeting.version ||
              JSON.stringify(value.result.historyScope) !== JSON.stringify(requestedScope)))
        )
          throw new Error("PREPARATION_SCOPE_MISMATCH");
        setJob(value);
        setError("");
        if (["queued", "running", "complete"].includes(value.status))
          timer = setTimeout(() => void poll(), value.status === "complete" ? 10000 : 2000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setJob(undefined);
        setError(errorMessage(cause));
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          setJobId("");
          storeRemembered(storageKey, null);
        }
        // No automatic recreation: an existing durable job may still be running.
      }
    };
    setJob(undefined);
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, base, jobId, meeting.id, meeting.version, requestedScope, retry, storageKey]);
  function select(value: string) {
    setSelected(value);
    setConfirmed(false);
    setJob(undefined);
    setJobId("");
    setRequestedScope(null);
    setError("");
    storeRemembered(storageKey, null);
  }
  function inputScope() {
    const [kind, value] = selected.split(":");
    return scope.parse({ kind, id: kind === "workspace" ? null : value });
  }
  return (
    <section className="panel" aria-label="Next meeting preparation">
      <h3>Next meeting preparation</h3>
      <p>
        Choose the history to review for this meeting. Only authorized meetings with confirmed
        project/customer assignments are included. This does not assign or share the meeting,
        approve an action, or schedule a bot.
      </p>
      <Feedback data={contexts} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed || !selected || jobId) return;
          const historyScope = inputScope(),
            body = { meetingId: meeting.id, historyScope, confirmedScope: true };
          void command.run(
            body,
            (key) =>
              api.request(`${base}/preparations`, preparationJob, {
                method: "POST",
                key,
                body,
                signal: abort.current.signal,
              }),
            (value) => {
              setRequestedScope(historyScope);
              setJobId(value.id);
              storeRemembered(storageKey, { jobId: value.id, historyScope });
              setConfirmed(false);
            },
          );
        }}
      >
        <label>
          Preparation history
          <select
            required
            value={selected}
            onChange={(event) => select(event.target.value)}
            disabled={command.busy}
          >
            <option value="">Select history deliberately</option>
            {projects.map((project) => (
              <option key={project.id} value={`project:${project.id}`}>
                Project: {project.name}
              </option>
            ))}
            {contexts.value?.customers.map((customer) => (
              <option key={customer.id} value={`customer:${customer.id}`}>
                Customer: {customer.name}
              </option>
            ))}
            {contexts.value?.meetings
              .filter((previous) => previous.id !== meeting.id)
              .map((previous) => (
                <option key={previous.id} value={`meeting:${previous.id}`}>
                  Meeting: {previous.title}
                </option>
              ))}
            <option value="workspace:">All history I can read in this workspace</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={command.busy || Boolean(jobId)}
          />
          I confirm this exact history scope for this preparation.
        </label>
        <button type="submit" disabled={command.busy || !confirmed || !selected || Boolean(jobId)}>
          {command.busy ? "Queuing preparation…" : "Prepare reviewed-history draft"}
        </button>
      </form>
      {command.error ? (
        <p role="alert">
          {errorMessage(command.error)} Retry the same command if its acknowledgement was lost; do
          not start a duplicate.
        </p>
      ) : null}
      {error ? (
        <p role="alert">
          {error} The previous draft is hidden until the existing job can be authorized again.
        </p>
      ) : null}
      {jobId ? (
        <>
          <p>Preparation operation: {jobId}. A queued operation is not a completed brief.</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Refresh existing preparation
          </button>
        </>
      ) : null}
      {job ? (
        <article aria-label="Preparation draft">
          <p role="status">
            {job.status}
            {job.errorCode ? ` — ${job.errorCode}` : ""}
          </p>
          {job.status === "invalidated" ? (
            <p>
              History, accepted records or access changed. The old draft was removed; review the
              current scope before requesting another.
            </p>
          ) : null}
          {job.status === "failed" ? (
            <p>
              Preparation did not complete. No generated content is presented as a finished brief.
            </p>
          ) : null}
          {job.status === "complete" && job.result ? (
            <>
              <p>
                This is a review-required draft, not accepted truth or an approved external action.
              </p>
              {job.result.partial ? (
                <p role="status">
                  Partial history: capture gaps, missing finalized evidence or uncertain sources
                  remain disclosed. Missing speech was not reconstructed.
                </p>
              ) : null}
              <h4>Evidence excerpts</h4>
              {job.result.findings.length ? (
                <ul>
                  {job.result.findings.map((finding, index) => (
                    <li key={`${finding.citation.segmentId}:${index}`}>
                      <q>{finding.text}</q>
                      <p>
                        <a href={`/w/${workspaceId}?meetingId=${finding.citation.meetingId}`}>
                          Open evidence meeting
                        </a>{" "}
                        · segment {finding.citation.segmentId} · revision{" "}
                        {finding.citation.revision}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No supported transcript excerpts were found.</p>
              )}
              <h4>Human-reviewed history</h4>
              {job.result.reviewedRecords?.length ? (
                <ul>
                  {job.result.reviewedRecords.map((record) => (
                    <li key={record.id}>
                      <h5>
                        {record.kind}: {record.title}
                      </h5>
                      <p>{record.text}</p>
                      <p>
                        Human-reviewed status: {record.state}; revision {record.version}. External
                        task status: unknown, not verified.
                      </p>
                      <p>
                        {record.dueDate ?? "Due date unknown"} ·{" "}
                        {record.ownerId
                          ? `Responsible member ${record.ownerId}`
                          : "Responsible person unknown"}{" "}
                        · evidence {record.evidenceStatus}
                        {record.sourcePartial ? " · partial evidence" : ""}.
                      </p>
                      <a href={`/w/${workspaceId}?meetingId=${record.meetingId}`}>
                        Open reviewed source meeting
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No reviewed records are included in this draft.</p>
              )}
              <h4>Questions to review for the next meeting</h4>
              {job.result.questions.length ? (
                <ul>
                  {job.result.questions.map((question, index) => (
                    <li key={`${question.commitmentId}:${index}`}>
                      <p>{question.text}</p>
                      <p>
                        Reviewed commitment revision {question.commitmentVersion}.{" "}
                        {question.statusVerifiedAt
                          ? "Status verification reference available; review its source."
                          : "External status is not verified; ask for clarification."}
                      </p>
                      <a href={`/w/${workspaceId}?meetingId=${question.sourceMeetingId}`}>
                        Open commitment meeting
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No supported commitment questions are available.</p>
              )}
            </>
          ) : null}
        </article>
      ) : null}
      {job && ["complete", "failed", "invalidated"].includes(job.status) ? (
        <button type="button" onClick={() => select(selected)}>
          Review scope for a new preparation
        </button>
      ) : null}
    </section>
  );
}
