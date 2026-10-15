import { useState } from "react";
import { z } from "zod";
import { Api, ApiError, type Meeting } from "./api.js";
import { Form, Feedback, useCommand, useData } from "./ui.js";
import {
  acceptedActionCommitment,
  actionConnection,
  actionDraft,
  reviewedAction,
} from "./workflow-model.js";

export function CommitmentActionDraft({
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
  const [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<z.infer<typeof acceptedActionCommitment> | null>(null),
    [connectionId, setConnectionId] = useState(""),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [dueDate, setDueDate] = useState("");
  const command = useCommand();
  const records = useData(
    (signal) =>
      api.request(
        `${path}/commitments?scopeKind=meeting&scopeId=${meeting.id}`,
        z.array(acceptedActionCommitment).max(100),
        { signal },
      ),
    [api, path, meeting.id, revision],
  );
  const connections = useData(
    (signal) =>
      api.request(`${path}/action-connections`, z.array(actionConnection).max(100), { signal }),
    [api, path, revision],
  );
  const current = records.value?.find((record) => record.id === selected?.id),
    usable =
      !!current &&
      current.meetingId === meeting.id &&
      current.version === selected?.version &&
      current.state === "open" &&
      current.evidenceStatus === "current",
    connection = connections.value?.find(
      (value) => value.id === connectionId && value.status === "configured",
    );
  function clear() {
    setSelected(null);
    setTitle("");
    setDescription("");
    setDueDate("");
  }
  return (
    <section aria-label="Draft task from reviewed commitment">
      <h3>Draft from an accepted commitment</h3>
      <p>
        Choose an open human-reviewed commitment with current evidence. Saving creates only a draft;
        exact-payload approval and external execution remain separate.
      </p>
      <Feedback data={records} />
      <Feedback data={connections} />
      <button
        type="button"
        disabled={command.busy}
        onClick={() => {
          clear();
          setRevision((value) => value + 1);
        }}
      >
        Refresh accepted sources and connectors
      </button>
      {records.value?.length === 100 ? (
        <p>This list is bounded at 100 commitments; it is not a complete workspace export.</p>
      ) : null}
      <label>
        Accepted commitment
        <select
          value={selected?.id ?? ""}
          disabled={command.busy || records.loading || !!records.error}
          onChange={(event) => {
            const value = records.value?.find(
              (record) =>
                record.id === event.target.value &&
                record.meetingId === meeting.id &&
                record.state === "open" &&
                record.evidenceStatus === "current",
            );
            setSelected(value ?? null);
            setTitle(value?.title ?? "");
            setDescription(value?.text ?? "");
            setDueDate(value?.dueDate ?? "");
          }}
        >
          <option value="">Choose reviewed evidence</option>
          {records.value
            ?.filter((record) => record.meetingId === meeting.id)
            .map((record) => (
              <option
                key={record.id}
                value={record.id}
                disabled={record.state !== "open" || record.evidenceStatus !== "current"}
              >
                {record.title} · revision {record.version} · {record.state} · evidence{" "}
                {record.evidenceStatus}
              </option>
            ))}
        </select>
      </label>
      {selected ? (
        <>
          <p>
            Accepted commitment {selected.id}, revision {selected.version}. Human reviewed; external
            completion is unknown.
          </p>
          {selected.sourcePartial ? (
            <p>Partial meeting evidence remains disclosed; missing speech was not reconstructed.</p>
          ) : null}
          <Form
            title="Review linked task draft"
            button="Save linked draft (does not execute)"
            command={command}
            disabled={!usable || connections.loading || !!connections.error}
            submit={() => {
              if (!usable || !connection || !selected) return;
              const input = {
                connectionId: connection.id,
                provider: connection.provider,
                destination: connection.destination,
                payload: { title, description, dueDate: dueDate || null },
                source: {
                  meetingId: meeting.id,
                  revision: meeting.version,
                  commitment: { id: selected.id, version: selected.version },
                },
              };
              void command.run(
                input,
                async (key) => {
                  const source = await api.request(
                    `${path}/commitments/${selected.id}`,
                    acceptedActionCommitment,
                  );
                  if (
                    source.id !== selected.id ||
                    source.meetingId !== meeting.id ||
                    source.version !== selected.version ||
                    source.state !== "open" ||
                    source.evidenceStatus !== "current"
                  )
                    throw new ApiError("COMMITMENT_REVISION_CHANGED", 409);
                  return api.request(`${path}/actions`, reviewedAction, {
                    method: "POST",
                    key,
                    body: actionDraft.parse(input),
                  });
                },
                () => {
                  clear();
                  changed();
                },
              );
            }}
          >
            <label>
              Configured task connector
              <select
                required
                value={connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
              >
                <option value="">Choose configured destination</option>
                {connections.value
                  ?.filter((value) => value.status === "configured")
                  .map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.provider} · {value.destination} · {value.id}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Linked task title
              <input
                required
                maxLength={250}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              Linked exact description
              <textarea
                maxLength={12000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label>
              Linked due date (optional)
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </label>
            <p>
              Destination: {connection?.destination ?? "not selected"}. The accepted version is
              bound to the draft. Editing this task does not correct or complete the accepted
              commitment.
            </p>
          </Form>
        </>
      ) : null}
      {!connections.loading &&
      !connections.error &&
      !connections.value?.some((value) => value.status === "configured") ? (
        <p>
          No configured connector is available. Administrator credential setup is required; this
          screen does not complete provider OAuth.
        </p>
      ) : null}
    </section>
  );
}
