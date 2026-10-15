# Accepted commitments and approved actions

Meeting detail mounts `WorkflowPanel`. Owners may now choose an open, human-reviewed commitment
with current evidence and a configured private Jira/GitHub/Linear connector. The draft starts
from the reviewed title, statement and explicitly recorded due date; null dates remain empty.
No responsible person or due date is inferred. Partial evidence is disclosed.

Saving reads the current accepted record again and sends the native Workflow action input with
`source: { meetingId, revision, commitment: { id, version } }`. The browser action schema preserves
that binding on all read/write round trips. A changed version, non-open status or unavailable
evidence prevents a new linked draft. Native Workflow revalidates this source at proposal,
approval, execution and dispatch proof; the browser is not the permission authority.

Saving a draft does not approve or execute it. The owner sees exact task title, description,
nullable due date, provider, destination, connection, meeting/accepted versions and approval
fingerprint. Explicit confirmation gates approval. A separate idempotent command queues approved
execution. Changes to accepted evidence prevent write readiness. Unknown/reconciling outcomes
are not success and disable replacement execution; provider lookup/reconciliation remains owned
by the backend. Revocation does not undo a task already created.

Confirmed creation is not confirmed completion. After a confirmed external reference, an explicit
**Check external task status** command reads the native Integration task-status endpoint, with
Workflow operation checks before/after the request. Operation/reference mismatches fail closed.
The display keeps the provider's `updatedAt` distinct from the local observation timestamp and
labels the result a snapshot, not continuous verification. It never changes a human commitment's
status or sends an external task write. Errors remove the displayed provider snapshot.

Owner action authorization is periodically rechecked through native Workflow list reads.
Authorization failures clear action/draft/status surfaces; workspace/meeting changes and unmount
abort reads. Shared readers have no action mutation surface. Configured connector metadata is
not proof provider OAuth/scopes or live writes have been qualified. Credential setup is not
implemented by this screen and no credentials are stored in the browser.

Controlled browser tests cover linked source versions, explicit approval/execution separation,
ambiguous outcomes, source changes, safe text rendering, reader restrictions and status snapshots.
These tests do not create real Jira/GitHub/Linear tasks. Live provider setup, accepted-status
feedback into preparation, complete accepted-record/agenda exports and owner-approved agenda
persistence remain separate gates.
