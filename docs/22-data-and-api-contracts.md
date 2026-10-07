# Data model, API and background-job contracts

Status: TARGET DESIGN, not a shipped API. Updated 2026-10-07.
Read [engineering design](20-engineering-design.md) before implementation.
Names below are intentional; preserve existing v1 APIs while introducing v2.

## 1. Common invariants

- Public IDs are UUID strings; all timestamps UTC ISO-8601, displayed in workspace timezone.
- Existing `Org` is the workspace; retain `org_id` internally and use `workspace_id` in v2 DTOs.
- Every tenant-owned table has `org_id`, created/updated timestamps and an immutable primary ID.
- Foreign keys between tenant tables include `(org_id, id)` against a unique parent key. An ID
  belonging to another workspace is never accepted even if the request includes a valid org_id.
- Authorization comes from authenticated identity plus server membership, not a body claim.
- Deleted/unauthorized object reads return indistinguishable 404 responses. Missing auth returns 401;
  known workspace members lacking a requested administrative capability receive 403.
- Cursor pagination is stable `(created_at, id)`, default 25, maximum 100. No unrestricted list/export.
- Optimistic `version` integers protect user-edited resources. A stale If-Match returns 409.
- New enums use explicit persisted string values plus constraints; unknown provider values normalize
  to unknown, never a successful state. No silent coercion from unsupported policies.

## 2. Core tables and ownership

| Entity | Required fields / keys | Constraints and behavior |
|---|---|---|
| Org / workspace | Existing ID, name; timezone, capture_policy, pilot_limits | Capture off until onboarding; admin-only policy changes |
| OrgMember | org_id, user_id, role | Unique workspace/user; owner/admin/member |
| Customer | org_id, name, status, version | Names need not be unique; archive preserves history |
| CustomerContact | org_id, customer_id, email, display_name, verified_rule | Normalize email; a contact can relate to multiple customers, requiring review |
| Project | org_id, customer_id nullable, name, visibility, status, version | Private by default; customer FK scoped to org |
| ProjectMember | org_id, project_id, user_id, role | owner/editor/viewer; user must be workspace member |
| Meeting | Existing ID/platform/title; owner_user_id, occurrence_id nullable | Meeting identity is not the join URL; owner controls Unassigned |
| MeetingAssignment | org_id, meeting_id, project_id, assigned_by, source, version | At most one primary project; moving emits invalidation event |
| CalendarOccurrence | org_id, connection_id, provider_event_id, original_start, start/end, status, revision | Unique provider connection/event occurrence; recurring reschedule preserves identity |
| CaptureRequest | org_id, meeting_id, requested_by, policy_snapshot, status, input_hash, idempotency_key | Unique org/key; payload mismatch returns 409 |
| CaptureAttempt | org_id, request_id, attempt_no, provider_binding_id, provider_record_id, state, error_code | Unique request/attempt; one active attempt per request |
| ProviderBinding | org_id, provider, endpoint_ref, account_scope_id, secret_ref, status | Credential endpoint selected by operator, never arbitrary user URL; unique provider/account scope across tenants |
| CaptureKeyLease | provider_binding_id, platform, native_key_hash, owner, fencing_version, expires_at | Serialize dispatch/stop for reused links; do not put passcodes in keys |
| CaptureEvent | org_id, attempt_id, event_id, event_type, provider_time, received_at, applied_at | Unique provider binding/event ID; sanitized allowlisted payload |
| TranscriptRevision | org_id, meeting_id, revision, state, source, finalized_at | Append revisions; finalization is explicit, not inferred from last segment |
| TranscriptSegment | org_id, revision_id, provider_segment_id, start/end, text, speaker_label, confidence, final | Unique revision/provider segment ID; finite ordered times |
| CoverageInterval | Existing scoped capture gaps; start/end, reason, source | Distinguish known gap, unknown coverage and captured interval |
| KnowledgeItem/Evidence/Edge | Reuse existing typed claims and evidence; add source revision and scope-safe lookup | Preserve source provenance; superseded claims not physically overwritten |
| SummaryVersion | org_id, scope_kind, scope_id, input_revision_hash, structured_summary, state | Unique scope/input revision; source links required |
| ChatThread | org_id, scope_kind, scope_id, creator_id, title, status, version | Fixed scope; private to creator in pilot; project access additionally required |
| ChatMessage | org_id, thread_id, role, state, content, client_request_id, source_revision | Unique thread/client request ID for user sends |
| AnswerCitation | org_id, message_id, meeting_id, segment_revision_id, offsets | Read only while current actor may access source |
| AgendaVersion | org_id, occurrence_id, input_revision_hash, sections, edited_by, version | User edits protected from auto-refresh overwrite |
| ProposedAction/Approval | Reuse approved-action rule; immutable approved_payload_hash | Changed payload requires new approval |
| UsageReservation/Ledger | org_id, request_id, unit, estimate/actual, status, expiry | Reserve before dispatch, reconcile once by provider usage identity |
| MediaDeletion | org_id, attempt_id, media_locator_ref, deadline, state, last_error, attempts | Deadline based on capture start; secrets/URLs never in logs |
| OutboxEvent / Job | org_id, operation, entity_id, input_revision, run_at, lease/fencing | Unique operation/entity/revision; bounded attempts and retry schedule |

Never concatenate tenant IDs into raw SQL. All repository operations take an authorized scope object.
Where a table uses polymorphic scope_kind/scope_id, its application service validates referenced entity
existence and tenant ownership transactionally; no generic endpoint accepts unchecked polymorphic IDs.

### Pilot role and visibility rules

Workspace owners/admins manage membership, provider connections, spending and audit metadata. They
do not automatically read every private project. A project owner manages access; editors assign
meetings/create content; viewers read. Threads are creator-private even inside a shared project.
Sharing chat threads is deferred; there is no public link capability in the pilot.

Unassigned meetings are visible to their owner. Assigning one to a project shares its transcript and
derived summary with that project's members; the UI must show this consequence. Moving requires
ownership of the meeting and edit access to the target. Customer aggregation uses only visible
projects/meetings, including citations, counts, timeline and summaries.

Revoking access invalidates caches and makes dependent private threads unreadable immediately.
Materialized customer/project summaries must be generated for a defined visibility scope; a globally
computed summary must never be returned to a user who cannot read all of its sources. Pilot default:
project summary shared with project members; customer summary computed/cached per authorized source set.

## 3. State contracts

Capture request internal states:

```text
queued -> dispatching -> accepted -> monitoring -> finalized
                  \-> dispatch_unknown -> reconciliation_required
queued -> cancelled
any pre-final state -> failed (classified, with partial artifacts retained when authorized)
```

Provider-normalized capture state: scheduled, joining, waiting_for_admission, blocked, capturing,
stopping, ended, failed, unknown. Preserve event history; terminal provider states never regress to
active due to a late webhook. A provider correction is a distinct audited reconciliation event.

Processing state: pending, transcribing, verifying, summarizing, ready, partial, failed.
Capture can be ended while processing is still transcribing. Empty transcript is not automatically a
successful silent meeting: require provider evidence distinguishing no speech from missing capture.

Stop state: not_requested, requested, acknowledged, confirmed, failed. A DELETE/stop acknowledgment
does not prove departure. Scheduled cancellation prevents dispatch; live stop is reconciled.

Deletion state: scheduled, deleting, primary_deleted, verified, overdue, failed.
`verified` requires the applicable provider/application deletion checks; backup-retention obligations
are tracked separately. Never label all backups deleted based on primary DELETE acknowledgment.

## 4. HTTP conventions

Base: `/api/v2/workspaces/{workspace_id}`. Existing v1 contracts stay available during migration.
JSON errors: `{error: {code, message, retryable, request_id}}`, with safe messages and no vendor body.
Use 422 validation, 409 conflict/version mismatch, 429 configured quota with Retry-After, and 503
unconfigured or unavailable dependency. Distinguish quota refusal from host admission refusal.

Mutations that can enqueue work or incur costs require `Idempotency-Key` (UUID). Store normalized
payload hash and response identity; a repeat with the same payload returns the original resource,
and a different payload returns 409. Keys are tenant/operation scoped and retained with the request.

| Method / suffix | Input | Result / access |
|---|---|---|
| POST /customers | name, optional confirmed contacts | 201 customer; workspace member |
| GET /customers | cursor, query, status | Authorized directory projection |
| PATCH /customers/{id} | name/status + If-Match | Updated version; creator/admin policy |
| POST /projects | name, optional customer_id | 201 private project with creator as owner |
| GET /projects/{id} | — | Project and current actor capabilities |
| PATCH /projects/{id} | allowed fields + If-Match | Project owner/editor, visibility owner-only |
| PUT /projects/{id}/members/{user_id} | role | Owner only; workspace membership required |
| DELETE /projects/{id}/members/{user_id} | — | Owner only; cannot remove last owner |
| GET /meetings | project/customer/status/date filters, cursor | Permission-filtered meetings |
| PUT /meetings/{id}/assignment | project_id + If-Match | Owner+target editor; emits scope invalidation |
| POST /captures | meeting_url, optional project_id/title/occurrence_id | 202 persisted request; idempotency required |
| GET /captures/{id} | — | Capture and processing status, freshness, gaps |
| POST /captures/{id}/stop | reason=user_requested | 202 durable stop intent; idempotency required |
| GET /meetings/{id}/transcript | revision, cursor | Canonical segments with times/speakers |
| POST /meetings/{id}/corrections | segment_id, base_revision, replacement text | 202 revision/reprocessing intent |
| GET /meetings/{id}/summary | version optional | Summary, source revision, coverage and citations |
| GET /projects/{id}/memory | version optional | Project memory or processing state |
| GET /customers/{id}/memory | version optional | Current actor's authorized customer source set |
| POST /threads | scope_kind, scope_id, title | 201 creator-private thread |
| GET /threads | scope filters, cursor | Actor's authorized saved threads |
| PATCH /threads/{id} | title/archive + If-Match | Creator only |
| GET /threads/{id}/messages | cursor | Persisted messages with accessible citations |
| POST /threads/{id}/messages | text, client_request_id | 202 generation ID; idempotency required |
| GET /generations/{id}/events | Last-Event-ID | SSE status/text/citation/done; thread access checked |
| POST /occurrences/{id}/agenda | objective optional | 202 generation; reuse if input unchanged |
| PATCH /agendas/{id} | edited sections + If-Match | New user-edited version |
| POST /actions/{id}/approve | payload_hash | Approval record + execution job |
| GET /usage | period | Used/reserved units and configured limits |
| POST /exports | permitted scope | 202 scoped export job |
| POST /deletions | permitted scope | 202 deletion operation with progress ID |

Example capture response (not proof of a deployed route):

```json
{
  "id": "capture-request-uuid",
  "meeting_id": "meeting-uuid",
  "capture_status": "scheduled",
  "processing_status": "pending",
  "last_transcript_at": null,
  "requires_host_admission": null
}
```

No client supplies provider keys, native provider IDs, status transitions, summary confidence,
usage cost or another actor's identity. `requires_host_admission=null` means unknown, not false.

## 5. Provider and ASR contracts

CaptureProvider operations: start validated target, get immutable-record status, get transcript
snapshot, request stop, delete terminal artifacts. Add recover-dispatch only when the pinned provider
offers sufficient occurrence/account facts to bind it safely. Unknown dispatch remains visible if
safe automatic association is impossible. Do not attach "newest meeting with same URL" blindly.

Normalized segment: provider record ID + segment ID, start/end seconds, text, optional speaker label,
optional language/confidence and final/draft marker. Speaker labels are provider claims, not globally
verified identities. Repeated segment delivery upserts by stable ID; newer confirmed revision wins,
late draft cannot downgrade it. Same text at different times is not a duplicate.

ASR input: typed chunk reference, meeting-relative offset, audio format, optional language hint and
optional participant channel ID. ASR result: timed tokens/segments, language, confidence where supplied,
usage and provider request ID. Never invent confidence=1.0 for a provider that omits it. Streaming and
file APIs are distinct adapters; a provider supporting file uploads is not automatically streaming STT.

## 6. Transaction and concurrency requirements

- Capture create locks the relevant workspace limit row, checks reservations, inserts request/usage
  reservation/outbox and commits. Database uniqueness resolves duplicate requests, not a prior SELECT.
- Job claim commits its attempt count and lease before external I/O. Retry updates use current fencing
  token; expired workers cannot publish. Heartbeats do not hold a transaction open.
- Provider-account/native-key lease serializes starts and stops across recurring occurrences.
  A lease timeout is not proof an external bot failed; reconcile before new creation.
- Finalization locks the capture request and inserts unique input-revision jobs exactly once.
- Summary publication compares the source revision; stale generated output is retained for diagnostics
  without becoming current. Corrections schedule a new generation.
- Integration approval and job insertion are atomic; payload hash changes revoke old approval.
- Deletion marks scope unavailable before asynchronous provider/storage work; reads cannot expose
  content while deletion is in progress. Failed cleanup remains observable and retried.

## 7. Migration and compatibility

Use additive Alembic migrations, explicit model registry and integration tests against PostgreSQL.
Migration order: workspace policies -> customers/projects/access -> occurrence/capture infrastructure
-> transcript versions -> summaries/chats/agendas -> usage/deletion projections.
Backfill historical meetings as owner-scoped Unassigned. Where owner cannot be established, quarantine
for workspace-admin assignment without granting transcript access by default. No inferred customer
assignment from historical titles alone.

Do not rename existing IDs or mutate old enum meanings. Introduce new columns/tables and compatibility
read adapters; move one route at a time. Constraints are validated against existing data before being
made mandatory. Downgrades that would discard new customer data require an export/restore plan;
application rollback should normally leave additive tables intact.
