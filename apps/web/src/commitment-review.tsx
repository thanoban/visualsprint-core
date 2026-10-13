import { useState } from "react";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { Api, errorMessage, type Meeting } from "./api.js";
import { Feedback, useCommand, useData } from "./ui.js";
const citation = z.object({ captureId: id, segmentId: id, revision: z.number().int().positive() });
const claim = z.object({
  kind: z.enum(["discussion", "decision", "commitment"]),
  text: z.string(),
  citation: citation.extend({ meetingId: id }),
});
const summary = z.object({
  id,
  status: z.string(),
  result: z.object({ claims: z.array(claim) }).nullable(),
});
const accepted = z.object({
  id,
  meetingId: id,
  kind: z.enum(["decision", "commitment"]),
  title: z.string(),
  text: z.string(),
  ownerId: id.nullable(),
  dueDate: z.string().nullable(),
  state: z.string(),
  version: z.number().int().positive(),
  citations: z.array(citation),
  sourcePartial: z.boolean(),
  humanCorrected: z.boolean(),
  evidenceStatus: z.enum(["current", "changed", "unavailable"]).optional(),
});
type Item = z.infer<typeof accepted>;
type Source = z.infer<typeof claim> & { jobId: string; claimIndex: number };
type Props = { api: Api; workspaceId: string; meeting: Meeting; owner: boolean };
export function CommitmentReview(props: Props) {
  return <Review key={`${props.workspaceId}:${props.meeting.id}`} {...props} />;
}
function Review({ api, workspaceId, meeting, owner }: Props) {
  const [revision, setRevision] = useState(0),
    [editing, setEditing] = useState<Item | null>(null),
    [kind, setKind] = useState<"decision" | "commitment">("commitment"),
    [title, setTitle] = useState(""),
    [text, setText] = useState(""),
    [ownerId, setOwnerId] = useState(""),
    [dueDate, setDueDate] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [selected, setSelected] = useState<Source | null>(null),
    [refs, setRefs] = useState<z.infer<typeof citation>[]>([]);
  const save = useCommand(),
    status = useCommand(),
    path = api.scope(workspaceId);
  const items = useData(
    async (signal) => {
      const query = `?scopeKind=meeting&scopeId=${meeting.id}`;
      return [
        ...(await api.request(`${path}/decisions${query}`, z.array(accepted), { signal })),
        ...(await api.request(`${path}/commitments${query}`, z.array(accepted), { signal })),
      ];
    },
    [api, path, meeting.id, revision],
  );
  const summaries = useData(
    (signal) =>
      owner
        ? api.request(`${path}/intelligence/meetings/${meeting.id}/summaries`, z.array(summary), {
            signal,
          })
        : Promise.resolve([]),
    [api, path, meeting.id, owner, revision],
  );
  const members = useData(
    (signal) => (owner ? api.members(workspaceId, signal) : Promise.resolve([])),
    [api, workspaceId, owner],
  );
  const sources: Source[] = (summaries.value ?? []).flatMap((job) =>
    job.status === "complete" && job.result
      ? job.result.claims.flatMap((c, index) =>
          c.citation.meetingId === meeting.id ? [{ ...c, jobId: job.id, claimIndex: index }] : [],
        )
      : [],
  );
  function clear() {
    setEditing(null);
    setTitle("");
    setText("");
    setOwnerId("");
    setDueDate("");
    setSelected(null);
    setRefs([]);
    setConfirmed(false);
  }
  function useSource(source: Source) {
    setSelected(source);
    setText(source.text);
    setRefs([
      {
        captureId: source.citation.captureId,
        segmentId: source.citation.segmentId,
        revision: source.citation.revision,
      },
    ]);
    setConfirmed(false);
    if (!editing) setKind(source.kind === "decision" ? "decision" : "commitment");
  }
  return (
    <section aria-label="Reviewed decisions and commitments">
      <h3>Reviewed decisions and commitments</h3>
      <p>
        Model excerpts are proposals. Only the meeting owner can accept or correct a record after
        reviewing its evidence. Unknown responsible people or dates stay empty; association with a
        project never grants meeting access.
      </p>
      <Feedback data={items} />
      {(items.value?.length ?? 0) >= 100 ? (
        <p>This bounded view shows at most 100 decisions and 100 commitments.</p>
      ) : null}
      <ul>
        {items.value?.map((item) => (
          <li key={item.id}>
            <h4>
              {item.kind}: {item.title}
            </h4>
            <p>{item.text}</p>
            <p>
              Human reviewed · revision {item.version} · {item.state} ·{" "}
              {item.ownerId ? `responsible member ${item.ownerId}` : "responsible person unknown"} ·{" "}
              {item.dueDate ?? "due date unknown"}
            </p>
            {item.sourcePartial ? (
              <p>Partial meeting evidence. Missing speech has not been reconstructed.</p>
            ) : null}
            {item.evidenceStatus === "changed" ? (
              <p role="status">
                Evidence changed since review. Your human correction is preserved, not automatically
                regenerated.
              </p>
            ) : item.evidenceStatus === "unavailable" ? (
              <p role="status">
                Evidence cannot currently be revalidated; this is a human-reviewed record, not newly
                verified evidence.
              </p>
            ) : null}
            <p>
              {item.citations
                .map(
                  (c) => `capture ${c.captureId}, segment ${c.segmentId}, revision ${c.revision}`,
                )
                .join("; ")}
            </p>
            {owner ? (
              <>
                <button
                  onClick={() => {
                    setEditing(item);
                    setKind(item.kind);
                    setTitle(item.title);
                    setText(item.text);
                    setOwnerId(item.ownerId ?? "");
                    setDueDate(item.dueDate ?? "");
                    setSelected(null);
                    setRefs(item.citations);
                    setConfirmed(false);
                  }}
                >
                  Review correction
                </button>
                <button
                  disabled={status.busy}
                  onClick={() => {
                    const state =
                      item.kind === "decision"
                        ? item.state === "superseded"
                          ? "accepted"
                          : "superseded"
                        : item.state === "completed"
                          ? "open"
                          : "completed";
                    if (
                      !window.confirm(
                        `Record your explicit human status change to ${state}? This does not create or update an external task.`,
                      )
                    )
                      return;
                    const body = { expectedVersion: item.version, confirmed: true, state };
                    void status.run(
                      { id: item.id, body },
                      (key) =>
                        api.request(
                          `${path}/${item.kind === "decision" ? "decisions" : "commitments"}/${item.id}/status`,
                          accepted,
                          { method: "POST", key, body },
                        ),
                      () => setRevision((v) => v + 1),
                    );
                  }}
                >
                  Record human status change
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {status.error ? <p role="alert">{errorMessage(status.error)}</p> : null}
      {owner ? (
        <>
          <h4>Review source excerpts</h4>
          {summaries.loading ? (
            <p>Loading source proposals…</p>
          ) : summaries.error ? (
            <p role="alert">
              {errorMessage(summaries.error)} Accepted records remain independent of model
              generation.
            </p>
          ) : null}
          {sources.length ? (
            <ul>
              {sources.map((source) => (
                <li key={`${source.jobId}:${source.claimIndex}`}>
                  <q>{source.text}</q>
                  <p>
                    {source.kind} proposal · segment {source.citation.segmentId} · revision{" "}
                    {source.citation.revision}
                  </p>
                  <button onClick={() => useSource(source)}>Use this evidence for review</button>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              Generate a finalized meeting summary to load evidence-linked proposals. Nothing is
              automatically accepted.
            </p>
          )}
          <form
            className="panel"
            onSubmit={(event) => {
              event.preventDefault();
              if (!confirmed || !refs.length) return;
              const content = {
                title,
                text,
                ownerId: kind === "decision" ? null : ownerId || null,
                dueDate: kind === "decision" ? null : dueDate || null,
                citations: refs,
              };
              const body = editing
                ? {
                    expectedVersion: editing.version,
                    expectedMeetingVersion: meeting.version,
                    confirmed: true,
                    content,
                  }
                : {
                    meetingId: meeting.id,
                    expectedMeetingVersion: meeting.version,
                    confirmed: true,
                    content,
                    proposal: selected
                      ? { jobId: selected.jobId, claimIndex: selected.claimIndex }
                      : null,
                  };
              const target = `${path}/${kind === "decision" ? "decisions" : "commitments"}${editing ? "/" + editing.id : ""}`;
              void save.run(
                { target, body },
                (key) =>
                  api.request(target, accepted, { method: editing ? "PATCH" : "POST", key, body }),
                () => {
                  clear();
                  setRevision((v) => v + 1);
                },
              );
            }}
          >
            <h4>{editing ? "Review and save correction" : "Accept a reviewed record"}</h4>
            <fieldset disabled={save.busy}>
              <label>
                Record kind
                <select
                  value={kind}
                  disabled={!!editing}
                  onChange={(e) => {
                    setKind(e.target.value as typeof kind);
                    setConfirmed(false);
                  }}
                >
                  <option value="commitment">Commitment</option>
                  <option value="decision">Decision</option>
                </select>
              </label>
              <label>
                Reviewed title
                <input
                  value={title}
                  maxLength={250}
                  required
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <label>
                Reviewed statement
                <textarea
                  value={text}
                  maxLength={12000}
                  required
                  onChange={(e) => {
                    setText(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              {kind === "commitment" ? (
                <>
                  <label>
                    Responsible workspace member (optional)
                    <select
                      value={ownerId}
                      onChange={(e) => {
                        setOwnerId(e.target.value);
                        setConfirmed(false);
                      }}
                    >
                      <option value="">Unknown / not yet confirmed</option>
                      {members.value
                        ?.filter((m) => m.active)
                        .map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.userId === meeting.ownerId
                              ? "Meeting owner (you)"
                              : `Workspace member ${m.userId}`}
                          </option>
                        ))}
                    </select>
                  </label>
                  {members.error ? (
                    <p>Member names are not available; leave responsibility unknown.</p>
                  ) : null}
                  <label>
                    Confirmed due date (optional)
                    <input
                      type="date"
                      value={dueDate}
                      onChange={(e) => {
                        setDueDate(e.target.value);
                        setConfirmed(false);
                      }}
                    />
                  </label>
                </>
              ) : null}
              <p>
                {refs.length
                  ? "Evidence references selected and will be checked again by the owning service."
                  : "Choose a source excerpt before accepting."}{" "}
                Edited text is your human review; citations do not automatically prove an edited
                paraphrase.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />{" "}
                I reviewed the source and confirm this exact statement, responsible member and date.
              </label>
              <button
                type="submit"
                disabled={
                  !confirmed || !refs.length || !title.trim() || !text.trim() || text.length > 12000
                }
              >
                {save.busy
                  ? "Saving review…"
                  : editing
                    ? "Save reviewed correction"
                    : "Accept reviewed record"}
              </button>
              <button type="button" className="secondary" onClick={clear}>
                Clear review
              </button>
            </fieldset>
            {save.error ? <p role="alert">{errorMessage(save.error)}</p> : null}
          </form>
        </>
      ) : null}
    </section>
  );
}
