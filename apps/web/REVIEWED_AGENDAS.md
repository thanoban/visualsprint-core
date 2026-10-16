# Owner-reviewed agenda UI and versioned downloads

Meeting detail mounts `AgendaPanel` against the native Workspace agenda API. Explicit meeting
readers may view agendas; only the current owner sees create/correct/delete controls. Project
assignment and workspace administrator status do not grant access. Source requests are scoped,
aborted on unmount and periodically reauthorized. Failed access hides private rows and forms.

A new or corrected agenda requires nonempty, bounded title/text and an unchecked-by-default
human confirmation. Editing the text or changing the meeting revision resets that confirmation.
Preparation remains generated draft advice: users may manually paste and review it, but there is
no automatic copy, acceptance, model approval or external action. Deletion has its own exact
agenda/version review and explicit confirmation; it does not delete the meeting or transcript.

Every mutation sends an idempotency key, `confirmed: true` and `expectedMeetingVersion`; updates
and deletions additionally bind `expectedVersion`. The native response has no new meeting version,
so commands remain locked until a fresh authorized meeting read confirms an increased revision.
Meeting detail then reloads before further commands. The UI warns that this clears other unsaved
meeting forms, avoiding a quiet overwrite using text edited against an old revision.

An uncertain response locks replacement fields. **Retry same agenda request** preserves the
original payload, target, expected revisions and idempotency key, including when a write succeeded
but its response or subsequent meeting reload failed. Known atomic version conflicts require
renewed review against current state; they never silently retry with a newer version. Shared
readers and unavailable contexts expose no mutation controls.

`export-model.ts` supports two explicit artifact formats. Schema 2 preserves complete authorized
reviewed decisions, commitments, citations/evidence status and owner-reviewed agendas alongside
notes and transcript/capture metadata. It rejects incomplete markers, wrong meeting/source
revisions, unknown injected fields, malformed citations and oversized content. Human completion
is not provider-verified task completion; generated drafts and external verification are not
included. The download uses a fresh authenticated API call and validates the target before
creating its temporary Blob; the Blob URL is revoked afterward.

An authorized legacy schema-1 artifact is retained exactly as notes/transcripts and visibly
labeled as lacking reviewed-record/agenda coverage. No empty reviewed snapshot is invented and
schema-2 fields are not stripped during reserialization. Current-source validation may require a
fresh export rather than permitting download of an older stored artifact.

Controlled browser coverage includes explicit CRUD confirmation, increasing meeting/agenda
versions, same-command uncertain retries, conflict review, shared-reader restrictions, access and
scope clearing, safe text rendering and actual Blob payload preservation. Unit tests qualify
strict DTO validation. These browser APIs are controlled fixtures, not live Workspace/PostgreSQL
or full signed-service evidence. Owning agenda/export persistence, multi-service composition,
live identity/capture/provider setup and Azure rollout remain separate release gates. No Docker,
cloud resources, paid providers or external task writes are used by these checks.
