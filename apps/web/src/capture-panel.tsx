import { useEffect, useState } from "react";
import { z } from "zod";
import { Api, errorMessage, type Meeting } from "./api.js";
import { Form, useCommand } from "./ui.js";
const capture = z.object({
  id: z.string().uuid(),
  state: z.string(),
  ready: z.boolean(),
  coverage: z.string(),
  transcriptHealth: z.string(),
  errorCode: z.string().nullable(),
  version: z.number(),
  stopRequested: z.boolean(),
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
  const start = useCommand(),
    stop = useCommand();
  const path = api.scope(workspaceId);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setCaptures([]);
    setText(undefined);
    setError("");
    const poll = async () => {
      try {
        const values = await api.request(
          `${path}/meetings/${meeting.id}/captures`,
          z.array(capture),
          { signal: abort.signal },
        );
        const latest = values.at(-1);
        const content = latest
          ? await api.request(`${path}/captures/${latest.id}/transcript`, transcript, {
              signal: abort.signal,
            })
          : undefined;
        if (!abort.signal.aborted) {
          setCaptures(values);
          setText(content);
          setError("");
        }
      } catch (reason) {
        if (!abort.signal.aborted) {
          setCaptures([]);
          setText(undefined);
          setError(errorMessage(reason));
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
      ) : (
        <p>No capture requested.</p>
      )}
      {owner && meeting.joinUrl && !active ? (
        <Form
          title="Capture this meeting"
          button="Start capture"
          command={start}
          submit={() =>
            void start.run(
              { meetingId: meeting.id, version: meeting.version },
              (key) =>
                api.request(`${path}/captures`, capture, {
                  method: "POST",
                  key,
                  body: { meetingId: meeting.id, expectedMeetingVersion: meeting.version },
                }),
              () => setRevision((value) => value + 1),
            )
          }
        >
          <p>
            Maximum four hours. Notify participants and obtain the required permission before
            starting.
          </p>
        </Form>
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
