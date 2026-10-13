import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Api, errorMessage, type Meeting } from "./api.js";
import { Form, useCommand } from "./ui.js";
const exportJob = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  state: z.string(),
  format: z.enum(["text", "json"]),
  version: z.number().int(),
  errorCode: z.string().nullable(),
  expiresAt: z.string().datetime(),
});
const deletionJob = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  state: z.enum(["pending", "complete"]),
  required: z.array(z.string()),
  completed: z.array(z.string()),
});
const artifact = z.object({
  schemaVersion: z.literal(1),
  meetingId: z.string().uuid(),
  version: z.number().int().positive(),
  title: z.string(),
  notes: z.string(),
  captures: z.array(
    z.object({
      id: z.string().uuid(),
      version: z.number().int(),
      state: z.string(),
      coverage: z.string(),
      segments: z.array(
        z.object({
          id: z.string().uuid(),
          revision: z.number().int(),
          startMs: z.number(),
          endMs: z.number(),
          text: z.string(),
          speakerLabel: z.string().nullable(),
        }),
      ),
    }),
  ),
});
type Props = {
  api: Api;
  workspaceId: string;
  meeting: Meeting;
  owner: boolean;
  onDeletionAccepted?: (jobId:string) => void;
};
export function DataRightsPanel(props: Props) {
  return <ScopedRights key={`${props.workspaceId}:${props.meeting.id}`} {...props} />;
}
function ScopedRights({ api, workspaceId, meeting, owner, onDeletionAccepted }: Props) {
  const [exported, setExported] = useState<z.infer<typeof exportJob>>(),
    [deletion, setDeletion] = useState<z.infer<typeof deletionJob>>(),
    [confirmation, setConfirmation] = useState(""),
    [error, setError] = useState("");
  const abort = useRef(new AbortController());
  const create = useCommand(),
    download = useCommand(),
    remove = useCommand();
  const path = api.scope(workspaceId);
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => controller.abort();
  }, [api]);
  useEffect(() => {
    if (
      (!exported ||
        ["complete", "failed", "blocked", "expired", "deleted"].includes(exported.state)) &&
      deletion?.state !== "pending"
    )
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (
          exported &&
          !["complete", "failed", "blocked", "expired", "deleted"].includes(exported.state)
        ) {
          const next = await api.request(`${path}/exports/${exported.id}`, exportJob, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setExported(next);
        }
        if (deletion?.state === "pending") {
          const next = await api.request(`${path}/deletions/${deletion.id}`, deletionJob, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setDeletion(next);
        }
        if (!controller.signal.aborted) setError("");
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason));
          setExported(undefined);
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void poll();
          }, 3000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, path, exported?.id, exported?.state, deletion?.id, deletion?.state]);
  return (
    <section aria-label="Meeting data rights">
      <h3>Export and deletion</h3>
      <p>
        English text only. Exports contain notes, transcript revisions and capture-coverage labels;
        no recordings or screenshots. Artifacts expire after 24 hours and fresh permission checks
        apply to downloads.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {!deletion ? (
        <>
          <button
            disabled={create.busy}
            onClick={() => {
              const signal = abort.current.signal;
              void create.run(
                { meetingId: meeting.id, format: "json" },
                (key) =>
                  api.request(`${path}/exports`, exportJob, {
                    method: "POST",
                    key,
                    body: { meetingId: meeting.id, format: "json" },
                    signal,
                  }),
                (job) => {
                  if (!signal.aborted) setExported(job);
                },
              );
            }}
          >
            Create JSON export
          </button>
          {create.error ? <p role="alert">{errorMessage(create.error)}</p> : null}
        </>
      ) : null}
      {exported ? (
        <p role="status">
          Export: {exported.state}.{" "}
          {exported.errorCode === "EXPORT_CAPTURE_NOT_FINAL"
            ? "Waiting for capture finalization."
            : exported.errorCode
              ? "Generation could not complete; no missing content was invented."
              : ""}
        </p>
      ) : null}
      {exported?.state === "complete" && !deletion ? (
        <>
          <button
            disabled={download.busy}
            onClick={() => {
              const signal = abort.current.signal;
              void download.run(
                exported.id,
                async () => {
                  const content = await api.request(
                    `${path}/exports/${exported.id}/download`,
                    artifact,
                    { signal },
                  );
                  if (content.meetingId !== meeting.id) throw new Error("EXPORT_SCOPE_MISMATCH");
                  return content;
                },
                (content) => {
                  if (signal.aborted) return;
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `visualsprint-${exported.id}.json`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                },
              );
            }}
          >
            Download authorized export
          </button>
          {download.error ? <p role="alert">{errorMessage(download.error)}</p> : null}
        </>
      ) : null}
      {owner && !deletion ? (
        <Form
          title="Delete this meeting"
          button="Permanently request deletion"
          command={remove}
          disabled={confirmation !== meeting.title}
          submit={() => {
            if (confirmation !== meeting.title) return;
            const signal = abort.current.signal;
            const body = { meetingId: meeting.id, expectedVersion: meeting.version };
            void remove.run(
              body,
              (key) =>
                api.request(`${path}/deletions`, deletionJob, {
                  method: "POST",
                  key,
                  body,
                  signal,
                }),
              (job) => {
                if (signal.aborted) return;
                setExported(undefined);
                setConfirmation("");
                setDeletion(job);
                onDeletionAccepted?.(job.id);
              },
            );
          }}
        >
          <p>
            Access is blocked immediately. Cleanup is not complete until every owning service
            acknowledges; backup retention follows the disclosed policy. Type the meeting title to
            confirm.
          </p>
          <label>
            Confirm meeting title
            <input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
            />
          </label>
        </Form>
      ) : null}
      {deletion ? (
        <p role="status">
          Meeting access blocked. Deletion: {deletion.state}. Completed services:{" "}
          {deletion.completed.length}/{deletion.required.length}.{" "}
          {deletion.state === "pending" ? "Unacknowledged cleanup remains pending." : ""}
        </p>
      ) : null}
    </section>
  );
}
