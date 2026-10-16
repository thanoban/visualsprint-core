import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Api, ApiError, errorMessage, type Meeting } from "./api.js";
import { useCommand } from "./ui.js";
import {
  agendaSchema,
  agendaContent,
  agendaCorrection,
  agendaDeletion,
  agendaDeleted,
  type Agenda,
} from "./agenda-model.js";
type Props = {
  api: Api;
  workspaceId: string;
  meeting: Meeting;
  owner: boolean;
  onMeetingReload: (meeting: Meeting) => void;
};
type Pending = {
  method: "POST" | "PATCH";
  target: string;
  body:
    | z.infer<typeof agendaContent>
    | z.infer<typeof agendaCorrection>
    | z.infer<typeof agendaDeletion>;
  agendaId: string | null;
  deleting: boolean;
};
export function AgendaPanel(props: Props) {
  return <Agendas key={`${props.workspaceId}:${props.meeting.id}`} {...props} />;
}
function Agendas({ api, workspaceId, meeting, owner, onMeetingReload }: Props) {
  const path = `${api.scope(workspaceId)}/meetings/${meeting.id}`,
    [context, setContext] = useState<{ meeting: Meeting; agendas: Agenda[] }>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [editing, setEditing] = useState<Agenda | null>(null),
    [deleting, setDeleting] = useState<Agenda | null>(null),
    [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [deleteConfirmed, setDeleteConfirmed] = useState(false),
    [pending, setPending] = useState<Pending | null>(null);
  const command = useCommand(),
    abort = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => controller.abort();
  }, [api]);
  function clear() {
    setEditing(null);
    setDeleting(null);
    setTitle("");
    setBody("");
    setConfirmed(false);
    setDeleteConfirmed(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setContext(undefined);
    setError("");
    async function poll() {
      try {
        const [current, agendas] = await Promise.all([
          api.meeting(workspaceId, meeting.id, controller.signal),
          api.request(`${path}/agendas`, z.array(agendaSchema).max(100), {
            signal: controller.signal,
          }),
        ]);
        if (
          current.id !== meeting.id ||
          current.workspaceId !== workspaceId ||
          current.blocked ||
          agendas.some((agenda) => agenda.meetingId !== meeting.id) ||
          new Set(agendas.map((agenda) => agenda.id)).size !== agendas.length
        )
          throw new ApiError("AGENDA_CONTEXT_CHANGED", 409);
        if (!controller.signal.aborted) {
          setContext({ meeting: current, agendas });
          setError("");
          setLoading(false);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setContext(undefined);
          setLoading(false);
          setError(errorMessage(cause));
          if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) clear();
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, path, workspaceId, meeting.id, revision]);
  useEffect(() => {
    setConfirmed(false);
    setDeleteConfirmed(false);
  }, [context?.meeting.version]);
  const canWrite =
      owner && context?.meeting.ownerId === meeting.ownerId && !context.meeting.blocked,
    currentEditing = editing
      ? context?.agendas.find((agenda) => agenda.id === editing.id)
      : undefined,
    currentDeleting = deleting
      ? context?.agendas.find((agenda) => agenda.id === deleting.id)
      : undefined,
    stale = !!editing && currentEditing?.version !== editing.version,
    staleDelete = !!deleting && currentDeleting?.version !== deleting.version;
  function run(input: Pending) {
    if (!canWrite || command.busy) return;
    setPending(input);
    const signal = abort.current.signal;
    void command.run(
      input,
      async (key) => {
        try {
          if (input.deleting) {
            const result = await api.request(input.target, agendaDeleted, {
              method: "POST",
              key,
              body: agendaDeletion.parse(input.body),
              signal,
            });
            if (
              result.meetingId !== meeting.id ||
              result.id !== input.agendaId ||
              !("expectedVersion" in input.body) ||
              result.version !== input.body.expectedVersion + 1
            )
              throw new ApiError("AGENDA_CONTEXT_CHANGED", 409);
          } else {
            const result = await api.request(input.target, agendaSchema, {
              method: input.method,
              key,
              body:
                input.method === "PATCH"
                  ? agendaCorrection.parse(input.body)
                  : agendaContent.parse(input.body),
              signal,
            });
            if (result.meetingId !== meeting.id || (input.agendaId && result.id !== input.agendaId))
              throw new ApiError("AGENDA_CONTEXT_CHANGED", 409);
          }
          const fresh = await api.meeting(workspaceId, meeting.id, signal);
          if (
            fresh.id !== meeting.id ||
            fresh.workspaceId !== workspaceId ||
            fresh.blocked ||
            fresh.version <= input.body.expectedMeetingVersion
          )
            throw new ApiError("AGENDA_CONTEXT_CHANGED", 409);
          return fresh;
        } catch (cause) {
          if (
            !signal.aborted &&
            cause instanceof ApiError &&
            ["SOURCE_MEETING_CHANGED", "VERSION_CONFLICT", "AGENDA_SCOPE_TOO_LARGE"].includes(
              cause.code,
            )
          ) {
            setPending(null);
            setConfirmed(false);
            setDeleteConfirmed(false);
            setRevision((value) => value + 1);
          }
          throw cause;
        }
      },
      (fresh) => {
        if (!signal.aborted) {
          setPending(null);
          clear();
          setRevision((value) => value + 1);
          onMeetingReload(fresh);
        }
      },
    );
  }
  return (
    <section aria-label="Owner-reviewed agendas">
      <h3>Owner-reviewed agendas</h3>
      <p>
        These are explicitly reviewed meeting agendas, not generated preparation drafts. No model
        text is accepted automatically; sharing and project assignment remain separate.
      </p>
      <button
        type="button"
        disabled={command.busy}
        onClick={() => setRevision((value) => value + 1)}
      >
        Refresh reviewed agendas
      </button>
      {loading ? <p role="status">Loading authorized agendas…</p> : null}
      {error ? (
        <p role="alert">
          {error} Private agenda content is hidden until current access is verified.
        </p>
      ) : null}
      {context ? (
        <>
          {!context.agendas.length ? <p>No owner-reviewed agenda saved.</p> : null}
          <ul>
            {context.agendas.map((agenda) => (
              <li key={agenda.id}>
                <h4>{agenda.title}</h4>
                <p className="text-content">{agenda.body}</p>
                <p>
                  Owner reviewed · agenda revision {agenda.version} · meeting revision{" "}
                  {context.meeting.version}.
                </p>
                {canWrite ? (
                  <>
                    <button
                      type="button"
                      disabled={!!pending || command.busy}
                      onClick={() => {
                        clear();
                        setEditing(agenda);
                        setTitle(agenda.title);
                        setBody(agenda.body);
                      }}
                    >
                      Review agenda correction
                    </button>
                    <button
                      type="button"
                      disabled={!!pending || command.busy}
                      onClick={() => {
                        clear();
                        setDeleting(agenda);
                      }}
                    >
                      Review agenda deletion
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          {canWrite ? (
            <>
              {pending ? (
                <div role="status">
                  <p>
                    The original agenda command is awaiting confirmation and a fresh meeting reload.
                    Fields are locked to avoid replacement requests.
                  </p>
                  <button type="button" disabled={command.busy} onClick={() => run(pending)}>
                    Retry same agenda request
                  </button>
                </div>
              ) : null}
              {deleting ? (
                <div className="panel">
                  <h4>Confirm reviewed agenda deletion</h4>
                  <p>
                    {deleting.title} · exact revision {deleting.version}.
                  </p>
                  <p>Only this agenda is removed, not the meeting or its transcript.</p>
                  {staleDelete ? (
                    <p role="alert">This agenda changed. Reload and review before deletion.</p>
                  ) : null}
                  <label>
                    <input
                      type="checkbox"
                      checked={deleteConfirmed}
                      disabled={!!pending || command.busy || staleDelete}
                      onChange={(event) => setDeleteConfirmed(event.target.checked)}
                    />
                    I explicitly confirm deleting this exact reviewed agenda.
                  </label>
                  <button
                    type="button"
                    disabled={!deleteConfirmed || staleDelete || !!pending || command.busy}
                    onClick={() => {
                      if (!deleteConfirmed || staleDelete) return;
                      run({
                        method: "POST",
                        target: `${path}/agendas/${deleting.id}/delete`,
                        agendaId: deleting.id,
                        deleting: true,
                        body: {
                          expectedMeetingVersion: context.meeting.version,
                          expectedVersion: deleting.version,
                          confirmed: true,
                        },
                      });
                    }}
                  >
                    Delete reviewed agenda
                  </button>
                </div>
              ) : (
                <form
                  className="panel"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!confirmed || stale || pending || !title.trim() || !body.trim()) return;
                    run({
                      method: editing ? "PATCH" : "POST",
                      target: `${path}/agendas${editing ? "/" + editing.id : ""}`,
                      agendaId: editing?.id ?? null,
                      deleting: false,
                      body: {
                        title,
                        body,
                        confirmed: true,
                        expectedMeetingVersion: context.meeting.version,
                        ...(editing ? { expectedVersion: editing.version } : {}),
                      },
                    });
                  }}
                >
                  <h4>{editing ? "Review agenda correction" : "Review a new agenda"}</h4>
                  <fieldset disabled={!!pending || command.busy || stale}>
                    <label>
                      Reviewed agenda title
                      <input
                        required
                        maxLength={250}
                        value={title}
                        onChange={(event) => {
                          setTitle(event.target.value);
                          setConfirmed(false);
                        }}
                      />
                    </label>
                    <label>
                      Reviewed agenda text
                      <textarea
                        required
                        maxLength={32000}
                        value={body}
                        onChange={(event) => {
                          setBody(event.target.value);
                          setConfirmed(false);
                        }}
                      />
                    </label>
                    <p>
                      You may manually paste preparation text here, but must review it. Saving
                      reloads the meeting revision and clears other unsaved meeting forms.
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      I reviewed and confirm this exact agenda text.
                    </label>
                    <button type="submit" disabled={!confirmed || !title.trim() || !body.trim()}>
                      {editing ? "Save reviewed agenda correction" : "Save reviewed agenda"}
                    </button>
                  </fieldset>
                  {stale ? (
                    <p role="alert">
                      The agenda changed since this review. Refresh and review the current text.
                    </p>
                  ) : null}
                </form>
              )}
              <button type="button" disabled={!!pending || command.busy} onClick={clear}>
                Clear agenda review
              </button>
            </>
          ) : (
            <p>
              Read-only agenda access. Only the meeting owner may create, correct or delete an
              agenda.
            </p>
          )}
        </>
      ) : null}
      {command.error ? (
        <p role="alert">
          {errorMessage(command.error)} No replacement agenda is created automatically. An uncertain
          request must be retried unchanged.
        </p>
      ) : null}
    </section>
  );
}
