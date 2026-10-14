import { useEffect, useState } from "react";
import { z } from "zod";
import { Api, errorMessage, type Meeting } from "./api.js";
import { Form, useCommand } from "./ui.js";
import {
  CaptureProcessingControls,
  captureProcessingSchema,
} from "./capture-processing-controls.js";
const capture = z.object({
  id: z.string().uuid(),
  state: z.string(),
  ready: z.boolean(),
  coverage: z.string(),
  transcriptHealth: z.string(),
  errorCode: z.string().nullable(),
  version: z.number(),
  stopRequested: z.boolean(),
  dispatchNotBefore: z.string().datetime().optional(),
  processing: captureProcessingSchema.nullable().optional(),
});
const transcript = z.object({
  totalSegments: z.number().int(),
  segments: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      speakerLabel: z.string().nullable(),
      startMs: z.number(),
    }),
  ),
});
const terminal = new Set(["complete", "partial", "failed", "cancelled"]);
export function CapturePanel({
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
  const [captures, setCaptures] = useState<z.infer<typeof capture>[]>([]);
  const [text, setText] = useState<z.infer<typeof transcript>>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [startsAt, setStartsAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [processingConsent, setProcessingConsent] = useState(false);
  const start = useCommand(),
    stop = useCommand();
  const path = api.scope(workspaceId);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setCaptures([]);
    setText(undefined);
    setError("");
    setLoading(true);
    const poll = async () => {
      try {
        const values = await api.request(
          `${path}/meetings/${meeting.id}/captures`,
          z.array(capture),
          { signal: abort.signal },
        );
        const listed = values.at(-1);
        const latest = listed
          ? await api.request(`${path}/captures/${listed.id}`, capture, { signal: abort.signal })
          : undefined;
        if (latest && latest.id !== listed?.id) throw new Error("Capture status target changed.");
        const content = latest
          ? await api.request(`${path}/captures/${latest.id}/transcript`, transcript, {
              signal: abort.signal,
            })
          : undefined;
        if (!abort.signal.aborted) {
          setCaptures(latest ? [...values.slice(0, -1), latest] : values);
          setText(content);
          setError("");
          setLoading(false);
        }
      } catch (reason) {
        if (!abort.signal.aborted) {
          setCaptures([]);
          setText(undefined);
          setError(errorMessage(reason));
          setLoading(false);
        }
      } finally {
        if (!abort.signal.aborted)
          timer = setTimeout(() => {
            void poll();
          }, 5000);
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, path, meeting.id, revision]);
  const latest = captures.at(-1);
  useEffect(() => setProcessingConsent(false), [workspaceId, meeting.id, latest?.id]);
  const active = latest && !terminal.has(latest.state);
  return (
    <section aria-label="Meeting capture">
      <h3>Meeting capture</h3>
      <p>
        Meet, Zoom and Teams use an admitted notetaker. Host restrictions still apply. English
        transcript only; no retained recording or screenshots.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {latest ? (
        <p role="status">
          Status: {latest.state.replaceAll("_", " ")}. Transcript health: {latest.transcriptHealth}.
          Transcript coverage: {latest.coverage.replaceAll("_", " ")}.
          {latest.errorCode ? ` Reason: ${latest.errorCode}.` : ""}
        </p>
      ) : loading ? (
        <p>Loading current capture status…</p>
      ) : !error ? (
        <p>No capture requested.</p>
      ) : null}
      {latest?.state === "scheduled" && latest.dispatchNotBefore ? (
        <p>
          Join window opens: {new Date(latest.dispatchNotBefore).toLocaleString()}. Capacity is
          checked when due; this is not a confirmed meeting join.
        </p>
      ) : null}
      {owner && meeting.joinUrl && !loading && !error && !active ? (
        <Form
          title="Capture this meeting"
          button={startsAt ? "Schedule capture" : "Start capture"}
          command={start}
          submit={() =>
            void start.run(
              { meetingId: meeting.id, version: meeting.version, startsAt, processingConsent },
              (key) =>
                api.request(`${path}/captures`, capture, {
                  method: "POST",
                  key,
                  body: {
                    meetingId: meeting.id,
                    expectedMeetingVersion: meeting.version,
                    ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}),
                    ...(processingConsent
                      ? { processing: { consent: true, policyVersion: "english-text-v1" } }
                      : {}),
                  },
                }),
              () => {
                setProcessingConsent(false);
                setRevision((value) => value + 1);
              },
            )
          }
        >
          <label>
            Optional start time (your device timezone)
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={processingConsent}
              disabled={start.busy}
              onChange={(event) => setProcessingConsent(event.target.checked)}
            />
            I explicitly authorize automatic English transcript processing for this new capture
            using the configured AI budget.
          </label>
          <p>
            Optional and separate from capture or calendar consent. Setup may block dispatch;
            processing consent is not a completed summary or authorization for external actions.
          </p>
          <p>
            Maximum four hours. Notify participants and obtain the required permission before
            starting.
          </p>
        </Form>
      ) : null}
      {latest ? (
        <CaptureProcessingControls
          api={api}
          workspaceId={workspaceId}
          captureId={latest.id}
          owner={owner}
          processing={latest.processing}
          onChanged={() => setRevision((value) => value + 1)}
        />
      ) : null}
      {owner && active ? (
        <Form
          title="Stop capture"
          button={latest.stopRequested ? "Stop requested" : "Stop capture"}
          command={stop}
          submit={() =>
            void stop.run(
              { captureId: latest.id },
              () => api.request(`${path}/captures/${latest.id}/stop`, capture, { method: "POST" }),
              () => setRevision((value) => value + 1),
            )
          }
        >
          <p>Stopping is confirmed only after the bot leaves and late text is drained.</p>
        </Form>
      ) : null}
      {text ? (
        <>
          <h4>Transcript</h4>
          {text.totalSegments > text.segments.length ? (
            <p role="alert">
              This preview is truncated. Do not treat it as the complete transcript.
            </p>
          ) : null}
          {text.segments.map((segment) => (
            <p className="text-content" key={segment.id}>
              <strong>{segment.speakerLabel ?? "Unknown speaker"}</strong>: {segment.text}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}
