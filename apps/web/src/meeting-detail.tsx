import { useState } from "react";
import {
  Api,
  errorMessage,
  meetingSchema,
  type Meeting,
  type Member,
  type Project,
} from "./api.js";
import { Form, Feedback, useData, useCommand } from "./ui.js";
import { CapturePanel } from "./capture-panel.js";
import { DataRightsPanel } from "./data-rights-panel.js";
import { WorkflowPanel } from "./workflow-panel.js";
import { IntelligencePanel } from "./intelligence-panel.js";
import { CommitmentReview } from "./commitment-review.js";

export function MeetingPanel({
  api,
  workspaceId,
  meetingId,
  userId,
  projects,
  reload,
  onDeleted,
}: {
  api: Api;
  workspaceId: string;
  meetingId: string;
  userId: string;
  projects: Project[];
  reload: () => void;
  onDeleted?: (jobId: string) => void;
}) {
  const data = useData(
    async (signal) => ({
      meeting: await api.meeting(workspaceId, meetingId, signal),
      members: await api.members(workspaceId, signal),
    }),
    [api, workspaceId, meetingId],
  );
  return (
    <section className="meeting-detail" aria-label="Meeting details">
      <Feedback data={data} />
      {data.value ? (
        <MeetingEditor
          key={`${meetingId}/${data.value.meeting.version}`}
          api={api}
          workspaceId={workspaceId}
          initial={data.value.meeting}
          members={data.value.members}
          userId={userId}
          projects={projects}
          reload={reload}
          {...(onDeleted ? { onDeleted } : {})}
        />
      ) : null}
    </section>
  );
}
function MeetingEditor({
  api,
  workspaceId,
  initial,
  userId,
  projects,
  members,
  reload,
  onDeleted,
}: {
  api: Api;
  workspaceId: string;
  initial: Meeting;
  userId: string;
  projects: Project[];
  members: Member[];
  reload: () => void;
  onDeleted?: (jobId: string) => void;
}) {
  const [meeting, setMeeting] = useState(initial);
  const [deleted, setDeleted] = useState(false);
  const [notes, setNotes] = useState(initial.notes);
  const [projectId, setProjectId] = useState("");
  const [memberId, setMemberId] = useState("");
  const edit = useCommand();
  const assign = useCommand();
  const share = useCommand();
  const revoke = useCommand();
  const owner = meeting.ownerId === userId;
  const path = `${api.scope(workspaceId)}/meetings/${meeting.id}`;
  const changed = (value: Meeting) => {
    setMeeting(value);
    reload();
  };
  if (deleted)
    return (
      <p role="status">
        Meeting access is blocked. Deletion is queued; required services must finish cleanup before
        it is complete.
      </p>
    );
  return (
    <>
      <div className="row">
        <h2>{meeting.title}</h2>
        <span className="badge">{owner ? "You own this meeting" : "Shared with you"}</span>
      </div>
      <CapturePanel
        key={`capture/${workspaceId}/${meeting.id}`}
        api={api}
        workspaceId={workspaceId}
        meeting={meeting}
        owner={owner}
      />
      <IntelligencePanel
        key={`intelligence/${workspaceId}/${meeting.id}`}
        api={api}
        workspaceId={workspaceId}
        scope={{ kind: "meeting", id: meeting.id }}
      />
      <WorkflowPanel
        key={`workflow/${workspaceId}/${meeting.id}`}
        api={api}
        workspaceId={workspaceId}
        meeting={meeting}
        owner={owner}
      />
      <CommitmentReview api={api} workspaceId={workspaceId} meeting={meeting} owner={owner} />
      <DataRightsPanel
        key={`rights/${workspaceId}/${meeting.id}`}
        api={api}
        workspaceId={workspaceId}
        meeting={meeting}
        owner={owner}
        onDeletionAccepted={(jobId) => {
          setDeleted(true);
          setNotes("");
          onDeleted?.(jobId);
          reload();
        }}
      />
      {!owner ? (
        <>
          <h3>Notes</h3>
          <p className="text-content">{meeting.notes || "No notes yet."}</p>
        </>
      ) : (
        <>
          <Form
            title="Meeting notes"
            button="Save notes"
            command={edit}
            submit={() =>
              void edit.run(
                { notes, version: meeting.version },
                (key) =>
                  api.request(path, meetingSchema, {
                    method: "PATCH",
                    body: { notes, expectedVersion: meeting.version },
                    key,
                  }),
                changed,
              )
            }
          >
            <label>
              Notes
              <textarea
                rows={8}
                maxLength={32000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
          </Form>
          <div className="two-columns">
            <Form
              title="Confirm project assignment"
              button="Confirm assignment"
              command={assign}
              submit={() =>
                void assign.run(
                  { projectId, version: meeting.version },
                  (key) =>
                    api.request(`${path}/assignments`, meetingSchema, {
                      method: "POST",
                      body: { projectId, confirmed: true, expectedVersion: meeting.version },
                      key,
                    }),
                  changed,
                )
              }
            >
              <label>
                Project
                <select
                  required
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">Choose a project</option>
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint">Assignment organizes context. It does not give anyone access.</p>
            </Form>
            <div>
              <Form
                title="Share explicitly"
                button="Grant access"
                command={share}
                submit={() =>
                  void share.run(
                    { memberId, version: meeting.version },
                    (key) =>
                      api.request(`${path}/shares`, meetingSchema, {
                        method: "POST",
                        body: { userId: memberId, expectedVersion: meeting.version },
                        key,
                      }),
                    changed,
                  )
                }
              >
                <label>
                  Workspace member
                  <select
                    required
                    value={memberId}
                    onChange={(event) => setMemberId(event.target.value)}
                  >
                    <option value="">Choose a member</option>
                    {members
                      .filter((item) => item.active && item.userId !== userId)
                      .map((item) => (
                        <option key={item.userId} value={item.userId}>
                          {item.userId}
                        </option>
                      ))}
                  </select>
                </label>
                <p className="hint">
                  This person will be able to read this meeting, independently of its project.
                </p>
              </Form>
              <button
                className="secondary"
                disabled={!memberId || revoke.busy}
                onClick={() =>
                  void revoke.run(
                    { memberId, version: meeting.version },
                    (key) =>
                      api.request(`${path}/shares`, meetingSchema, {
                        method: "DELETE",
                        body: { userId: memberId, expectedVersion: meeting.version },
                        key,
                      }),
                    changed,
                  )
                }
              >
                Revoke selected member’s access
              </button>
              {revoke.error ? (
                <p role="alert" className="error">
                  {errorMessage(revoke.error)}
                </p>
              ) : null}
            </div>
          </div>
        </>
      )}
    </>
  );
}
