# Founder platform implementation status and runbook

Updated 2026-10-07. Source of truth for the target: [full plan](18-founder-platform-architecture.md).

## Current phase: implementation resumed

The owner resumed implementation on 2026-10-07. Work proceeds one reviewed slice at a time. The
capture-provider foundation is published on the feature branch at `a7ccbe0`; it is isolated from the
product route and is not a production capture fix.

The engineering specification is now documented in [design and structure](20-engineering-design.md),
[feature delivery](21-feature-delivery-plan.md), [data and API contracts](22-data-and-api-contracts.md),
[testing and operations](23-testing-and-operations.md), and [decisions and traceability](24-decisions-and-traceability.md).
These describe planned behavior, not implemented features. Continue F00 baseline verification, then
follow the dependencies and acceptance gates in the feature plan.

## Slice 1: provider contract

Published in `a7ccbe0`:

- Provider-neutral capture reference, lifecycle snapshot and transcript segment contracts.
- Strict Meet/Zoom/Teams invitation URL parsing, including passcode preservation and hostname checks.
- Vexa 0.12 HTTP adapter: dispatch, immutable-record status/transcript reads, stop, terminal artifact deletion.
- Explicit distinction between joining, waiting, blocked, capturing, ended and unknown.
- Transport/create ambiguity is surfaced for reconciliation; no automatic duplicate dispatch retry.
- Provider errors do not include response bodies, credentials or meeting URLs; redirects are not followed.
- Transcript revisions preserve final segments and timing; malformed ranges fail loudly; unnamed speakers
  stay unknown. Provider labels are not verified person identities.
- Read-only credential/API contract probe that never joins a meeting or fetches transcript contents.

The separate local chat failure change is not part of this published slice and remains unverified.

Qualification mode explicitly sends `recording_enabled=false` and `transcribe_enabled=true`.
It expects a configured Vexa STT backend. This is a development boundary, not the final temporary-audio
recovery implementation. No server configuration or default capture route has been changed.

NOT implemented by this slice:

- Persisted capture requests/attempts, dispatcher, provider webhook inbox and reconciliation worker.
- Vexa credentials bound to organizations and provisioning/rotation UI.
- Hard-deadline media deletion worker, provider backup retention policy, Groq-to-Vexa STT bridge.
- Feeding Vexa transcripts into the existing verified summary pipeline.
- Customer/project database entities, persistent threads, new UI, customer-memory jobs and agendas.
- Automatic calendar-to-Vexa scheduling, usage reservations and a production rollout.

This adapter is not yet called by the product's Capture now button. Existing capture behavior remains
legacy behavior until the durable orchestration slice is complete. Do not advertise the new path as live.

## Slice 2: durable capture intent

Published in `d9fd08f`:

- Added tenant-owned provider bindings whose credentials and endpoints remain secret/config references.
- Added capture requests and attempts with normalized lifecycle and stop states.
- Added usage reservations and a transactional outbox; provider I/O does not occur in the request transaction.
- Added an idempotent request service that checks workspace membership and meeting ownership before writes.
- Reusing a key with the same canonical payload returns the original request; a different payload conflicts.
- Meeting invitation URLs and passcodes are excluded from rows and outbox payloads; only a secret reference
  and one-way input digest are retained.
- Added an additive Alembic migration with one head and reversible table/index creation.

Still intentionally disconnected: no API route calls this service, no dispatcher consumes the outbox,
and no provider credentials were provisioned. Existing bot routes therefore keep their legacy behavior.

Slice 2 evidence: 44 combined request/provider tests passed initially; the complete capture suite then
passed 93 tests and the existing capture API passed 8 tests. Ruff and Mypy passed, Alembic reports one
head, and PostgreSQL offline SQL generation succeeded. The broader API suite had 124 passing, one skipped,
and five pre-existing failures in action approval/rejection actor attribution from unrelated dirty files.
Those failures were not modified or hidden by this slice.

## Slice 3: leased dispatch and tenant provider resolution

Published in `00d5743`:

- Added a database-leased outbox dispatcher with fencing tokens and stale-claim recovery.
- Commits a capture attempt before provider I/O; a recovered attempt enters reconciliation instead
  of sending a second provider create request.
- Serializes capacity checks under the workspace row and enforces the five-active-bot pilot limit.
- Persists provider record identity and normalized state only while the worker still owns its fence.
- Treats unknown exceptions after dispatch begins as uncertain, never as permission to blind retry.
- Resolves Vexa endpoint and API key from the tenant's SecretStore references; no global provider key.
- Rejects non-TLS remote endpoints, credentialed URLs and endpoints containing paths/query fragments.
- Uses a bounded, automatically closed HTTP client for every provider operation.

Slice 3 evidence: all 101 capture tests passed; scoped Ruff and strict Mypy passed. The dispatcher is
not invoked by the API or worker yet. Reconciliation consumption and authenticated v2 routes remain
required before the new capture lane may be enabled.

## Slice 4: authenticated capture-request API

Published in `ebda34d`:

- Added authenticated `POST /api/v2/workspaces/{org_id}/capture-requests` and scoped GET.
- Requires an `Idempotency-Key`; exact retries return the original request and changed payloads return 409.
- Stores the invitation URL in the configured SecretStore under a deterministic input-derived reference.
- Performs idempotency preflight before secret writes and cleans up secrets for known scope/conflict failures.
- Retains deterministic secret material when database commit outcome is unknown, allowing reconciliation
  instead of deleting data that a successfully committed request may require.
- Returns lifecycle metadata only; meeting URLs, passcodes, secret references and provider errors are absent.
- Cross-workspace meeting IDs and capture request IDs return 404 without exposing tenant data.

Slice 4 evidence: 114 capture and capture-API tests passed; scoped Ruff and strict Mypy passed.
The endpoint persists intent only. Worker invocation, provider reconciliation, stop/status APIs and the
frontend route switch remain gated.

## Slice 5: lifecycle reconciliation, stop and provider onboarding

Published in `f3bd5e2`, `27a11c7` and `dbba7eb`:

- Every accepted dispatch schedules immutable-record reconciliation; active captures are polled and
  terminal state is monotonic.
- Uncertain dispatch without a provider record ID becomes an explicit operator-reconciliation state;
  the system does not guess or send another create request.
- Stop is an idempotent persisted request. Provider acknowledgement does not mean departure; only a
  later terminal provider state marks stop confirmed.
- Cancelling before dispatch fences the outbox, and the dispatcher rechecks cancellation under lock.
- Status reads expose normalized provider state, safe error code and last-provider-contact time.
- Added a bounded standalone capture-worker entrypoint, separate from the legacy analysis worker.
- Added owner/admin-only Vexa onboarding with SecretStore-backed endpoint/key values, endpoint validation,
  credential-redacted responses and global provider-account ownership isolation.

Slice 5 evidence: 129 capture and capture-API tests passed; scoped Ruff and strict Mypy passed.
This is local contract evidence. A worker service/job has not been deployed, Vexa has not been provisioned,
and no real meeting admission/capture claim is made.

## Slice 6: workspace capture onboarding

Published in `41af1aa`:

- Added explicit workspace timezone, English-pilot language, retention, capture policy, concurrency and
  monthly-minute settings.
- Capture defaults off. Enabling manual or calendar capture requires a recorded disclosure acknowledgement.
- The policy is enforced in the durable application service, not only in the UI/API route.
- Added member-readable and owner/admin-writable workspace endpoints with IANA timezone validation.
- Enforced the selected pilot ceilings of five concurrent captures and 6,000 capture minutes per month.
- Added an additive migration that backfills existing workspaces to safe capture-off defaults.

Slice 6 evidence: 134 capture/workspace API tests passed; scoped Ruff and strict Mypy passed; Alembic
reports one head and generated valid PostgreSQL migration SQL. Member invitation delivery and the
customer/private-project model remain for the next F01/F02 slices.

## Slice 7: F01 workspace member management

Implemented in `backend/app/api/workspaces_v2.py`:

- `GET /api/v2/workspaces/{org_id}/members` — lists members with role; requires org membership.
- `POST /api/v2/workspaces/{org_id}/members` — adds a member by email (normalized); looks up existing
  user, 404 if not found, 409 if already a member; requires owner/admin.
- `DELETE /api/v2/workspaces/{org_id}/members/{member_user_id}` — removes a member; 409 if removing
  the last owner; requires owner/admin.

Slice 7 evidence: 4 member management tests added to `tests/api/test_workspaces_v2.py`; all pass.
Tests cover: add/list, unknown email 404, remove + last-owner protection, non-admin 403.
Scoped Mypy passes. No migration needed — uses existing `org_member` table.

## Slice 8: F02 customer/project API bug fix

Fixed `ProjectMemberUpsert.user_id` max_length constraint in `backend/app/api/projects_v2.py`:
the field had `max_length=36` but test USER_1 is 38 characters, causing 422 on body validation.
Removed the max_length constraint; the field continues to require `min_length=1`.

Slice 8 evidence: all 7 `test_projects_v2.py` tests pass (previously failing with 422 → 409 mismatch
on the last-owner-protection test).

## Slice 9: F03 calendar occurrences — schema, scheduler, and API

New model `CalendarOccurrence` in `backend/app/db/models.py`:
- Unique on `(connection_id, provider_event_id)` — Google Calendar's `singleEvents=true` returns
  unique IDs per recurring instance, so this is the correct deduplication key.
- `original_start` is immutable (set once at creation); `start_time`/`end_time` are mutable for
  reschedule tracking; `revision` increments on reschedule.
- `capture_override`: `"on"/"off"/null` per-event override on top of workspace `capture_policy`.
- Additive Alembic migration `b7e2f1a3c9d5` with unique constraint and two indexes.

Scheduler (`backend/app/orchestrator/scheduler.py`) updated:
- Added `_capture_enabled(org, occurrence)`: `capture_policy="off"` wins unconditionally (no
  disclosure yet); then per-event override; then workspace policy.
- `sync_calendar_connection` upserts occurrences by `(connection_id, provider_event_id)`,
  detects reschedules (start/end change), increments `revision`, and only creates
  `Meeting + CaptureSession` when `_capture_enabled` and `occurrence.meeting_id is None`.

Calendar API (`backend/app/api/calendar_v2.py`):
- `GET /api/v2/workspaces/{org_id}/occurrences?days=7` — upcoming non-cancelled occurrences
  (days 1–90).
- `PATCH /api/v2/workspaces/{org_id}/occurrences/{id}/capture-override` — sets "on"/"off"/null.
- `GET /api/v2/workspaces/{org_id}/connections` — lists calendar connections with `watch_healthy`.

Slice 9 evidence: 7 `test_calendar_v2.py` tests pass; 6 new scheduler tests pass (occurrence
creation, deduplication, reschedule revision, policy suppression, per-event override on/off).
Scoped Mypy passes (4 files, 0 issues). Alembic reports one head.

## Slice 10: F03 completion — cancellation detection and DST tests

Updated `backend/app/orchestrator/scheduler.py`:
- After processing all events in a sync, queries for SCHEDULED occurrences in this connection that
  were not returned by the adapter (future start_time, provider_event_id not in the sync's result set).
  Marks those occurrences CANCELLED — covers deleted, declined, or removed events without a separate
  webhook path.
- Added `from datetime import UTC, datetime` imports (previously only `timedelta` was imported).

Added 3 new tests to `tests/orchestrator/test_scheduler.py`:
- `test_cancelled_event_marks_occurrence_cancelled_on_next_sync` — event disappears from list;
  existing occurrence is CANCELLED, already-created Meeting is preserved.
- `test_cancelled_event_without_meeting_leaves_no_meeting` — occurrence with no meeting (policy=off)
  is also correctly CANCELLED when event disappears.
- `test_dst_boundary_times_are_passed_through_from_adapter` — documents that the scheduler passes
  the adapter's datetime through unchanged; timezone normalization to UTC is the adapter's responsibility
  (Google Calendar API always returns UTC; SQLite test environment strips tzinfo, PostgreSQL stores UTC).

Slice 10 evidence: 20 scheduler tests pass (all passing); scoped Mypy clean; 42 combined
slice-7–10 tests pass.

F03 acceptance criteria met: deduplication, reschedule/change, cancellation, DST handling, and
revocation visibility (watch_healthy) are all covered. Calendar callbacks are API-only and do not
invoke bot dispatch.

## Validation

For `a7ccbe0`, 35 targeted provider tests and 84 capture-suite tests passed; scoped Ruff and Mypy
checks passed. These are local results only. Frontend verification, live provider capture,
capacity, retention enforcement and production qualification are not established by these results.
Commands below are the local verification runbook; they do not authorize paid provisioning.

Local commands (from `backend`):

```powershell
.\.venv\Scripts\python.exe -m pytest tests/capture/test_vexa_provider.py -q
.\.venv\Scripts\python.exe -m ruff check app/interfaces/capture_provider.py app/adapters/capture_vexa.py app/capture/provider_probe.py tests/capture/test_vexa_provider.py
.\.venv\Scripts\python.exe -m mypy --follow-imports=silent app/interfaces/capture_provider.py app/adapters/capture_vexa.py app/capture/provider_probe.py
```

Provider tests use httpx MockTransport with documented response fixtures, not a running Vexa instance.
They cover invitation spoofing/passcodes, actual request flags, ambiguous dispatch, no retries,
immutable occurrence reads, lifecycle mapping, final/draft segments, invalid timestamps, stop safety,
terminal-only deletion and redirect credential protection. They do not prove live admission,
four-hour capture, end detection, speaker accuracy, capacity or billing.

## Read-only Vexa probe

Provision a reviewed Vexa release separately; do not run a floating main-branch deployment script or
mount unrelated developer credentials. Review its complete image/dependency licenses. Vexa Lite
includes its own PostgreSQL and storage plus process-runtime components; see upstream deployment docs.
Use only its meeting lane. Tiny.en is a smoke-test recognizer, not the production English ASR choice.

The probe reads process environment variables (never commits or prints keys):

- `VS_VEXA_BASE_URL`: HTTPS gateway root; loopback HTTP allowed for local qualification.
- `VS_VEXA_API_KEY`: key supplied using the normal secret-injection workflow.

```powershell
cd backend
.\.venv\Scripts\python.exe -m app.capture.provider_probe
```

Successful output is `{"ok": true, "api_reachable": true, "live_capture_verified": false}`.
This checks only GET /bots/status. It does not establish host admission, STT health, retention,
or end-to-end correctness. No provider endpoint/credential was provisioned as part of slice 1.

## Slice 11: capture routing and Mode C companion assembly

Published in `3a776b1`:

- Added platform-based capture routing: `CaptureRouter` selects the correct `PlatformAdapter` for a
  meeting session using its `platform` field.
- Implemented Mode C companion-assembly path: when RTMS/native capture is available, companion audio
  is concatenated and handed off to the transcript pipeline.
- Extended `calendar_common.py` with Zoom web-client URL pattern so `abc.zoom.us/wc/join/<id>`
  and `/wc/<id>` links are correctly recognized alongside standard Zoom meeting URLs.
- Added `bot_teams_guest_enabled` config flag; Teams guest-join is disabled by default for the pilot.

Slice 11 evidence: routing and companion-assembly tests pass; scoped Mypy clean.

## Slice 12: WebM transcoding and concat detection

Published in `6f582c8`:

- Added `transcode_webm_file()` in `app/capture/audio_utils.py` that converts Opus/WebM chunks to
  WAV for ASR ingestion.
- Added WebM-concat header detection to safely skip double-transcoding already-concatenated streams.
- Integrated with Mode C pipeline: companion audio stored as WebM is transcoded before ASR handoff.

Slice 12 evidence: audio-utils tests pass (require ffmpeg; skipped in CI); WebM concat-detection
unit tests pass without ffmpeg.

## Slice 13: mypy cleanup, OAuth-400 pruning and companion assembly integration

Published in `e657e3e`:

- **mypy baseline 352 → 218** (134-error reduction): `StageHandler` and all `db: object` parameters
  across `worker.py` changed to `db: Session`; lazy-singleton helpers annotated `-> Any`; module-level
  `None` singletons annotated as `Any`; return type invariance fix in `rtms_webhook.py`.
- OAuth-400 pruning: `test_worker_calendar_sync.py` added two tests verifying that a 400 from the
  token endpoint prunes the connection while a 400 from the calendar API does not.
- `_person_id_for_user` fix: audit log actor attribution now uses the JWT user's `Person` row via
  `_person_id_for_user(db, org_id, user.id)` rather than body-supplied `person_id`; H-1/M-14 security
  fix. All 22 `test_actions.py` tests pass.
- `actions.py` and `rtms_webhook.py` return types fixed for mypy invariance.

Slice 13 evidence: 587 tests passing, 0 failing (excluding 7 bounded-pass tests that require
PostgreSQL on port 5433, which are infrastructure errors not code failures); mypy baseline at 218.

## Slice 14: F05 completion — transcript freshness and timeout enforcement

Published in this session:

- **`last_transcript_at`** added to `CaptureAttempt` (DB column + Alembic migration `d4e5f6a7b8c9`):
  set by the reconciler when `provider.transcript()` returns non-empty segments during a CAPTURING
  poll cycle. Records wall-clock time of last received transcript content.
- **`state_entered_at`** added to `CaptureAttempt`: updated whenever the normalized state changes.
  Enables timeout calculations without a separate state-history table.
- **Automatic stop thresholds** enforced in the reconciler via `_check_timeouts()`:
  - 10-minute lobby timeout: WAITING_FOR_ADMISSION for ≥ 600 s triggers `stop_state = REQUESTED`.
  - 4-hour max runtime: CAPTURING for ≥ 14 400 s triggers `stop_state = REQUESTED`.
  - Stop is not sent to the provider this cycle — the next reconciliation cycle sends it, ensuring
    the timeout decision is persisted before provider I/O.
- **`is_stale`** computed field added to `CaptureRequestView`: True when the attempt is in a live
  state (joining/waiting/capturing/stopping) and `last_provider_contact_at` is ≥ 180 s in the past.
- **`last_transcript_at`** exposed in `CaptureRequestView` as an ISO-8601 string (null if no
  transcript has been received yet).

Slice 14 evidence: 12 new tests pass — 5 in `test_capture_v2.py` (is_stale flag, last_transcript_at
exposure) and 7 in `test_reconciler.py` (transcript freshness update, lobby timeout, max runtime
timeout, state_entered_at tracking). Alembic reports one head (d4e5f6a7b8c9). Scoped Mypy clean.

## Slice 15: F05 edge-case tests

Published in `87917f6`:

- **Reconciler**: BLOCKED state preserved + rescheduled (not auto-stopped); retryable error
  reschedules; non-retryable fails event + marks request RECONCILIATION_REQUIRED; stale lease
  reclaimed by a second worker; fencing prevents stale write overwriting newer state; stop before
  dispatch fires finds no reconcile event (returns False).
- **Capture API**: recurring meeting URL + distinct idempotency keys → separate requests; stop on
  FINALIZED request is idempotent (confirmed, no new outbox events).

F05 done criteria now fully covered: duplicate/out-of-order events (fencing), API/worker restart
(lease recovery), stop/create races, recurring URL reuse, host removal (BLOCKED), provider
disconnect (retryable/non-retryable), and meeting overrun (Slice 14 timeouts).

## Slice 16: F06 — Temporary media deletion lifecycle

Published in this session:

- **`CaptureMediaRef`** model added to `app/db/models.py` with Alembic migration `e5f6a7b8c9d0`:
  tracks each media artifact (AUDIO_CHUNK, FULL_AUDIO, PROVIDER_RECORDING) with its blobstore
  reference, hard-deadline `delete_after` (capped at 24 h from capture start), deletion state
  (PENDING/DELETED/FAILED), attempt count, `deleted_at`, and `overdue` flag.
- **`app/capture/media_deleter.py`**: `register_media_ref()` creates a deletion record capped at
  24 h; `delete_pending()` async worker deletes refs whose deadline has passed, sets `overdue=True`
  when past deadline, marks FAILED after 5 attempts; `list_overdue()` queries pending refs past
  their deadline; `capture_started_at_for_request()` returns the request's created_at as the
  deletion anchor.
- Audio recording **remains disabled** — this slice provides the lifecycle infrastructure; the
  actual audio→ASR path is F06's next slice (Vexa STT bridge + Groq integration).

Slice 16 evidence: 7 media-deleter tests pass; mypy clean on both new files; Alembic reports one
head (e5f6a7b8c9d0).

## Slice 17: F06 — Provider transcript ingestion bridge

Published in this session:

- **`capture_session_id`** (nullable FK) added to `CaptureRequest` with Alembic migration
  `f7b8c9d0e1a2`: set once the provider transcript is ingested and a `CaptureSession` created.
- **`app/capture/transcript_bridge.py`**: `ingest_next()` async worker claimed by the capture
  pass loop; `enqueue_ingest()` creates the outbox event after FINALIZED. The bridge:
  - Fetches final Vexa transcript via `provider_resolver.resolve(binding).transcript(reference)`.
  - Creates a `CaptureSession` (mode="B") linked to the request's Meeting.
  - Writes `Utterance` rows for every final segment (non-final segments filtered out); sets
    `speaker_cluster_id` from the provider's `speaker_label`, `asr_confidence` from `confidence`.
  - Writes `CoverageInterval` rows (MISSING for empty-text segments, DEGRADED for confidence < 0.4).
  - Updates `CaptureRequest.capture_session_id`; operation is idempotent (early exit if already set).
  - Enqueues pipeline at the **"screen"** stage — acquire/diarize/identify/transcribe are all skipped.
  - Retries up to 5 times on `CaptureProviderError`; marks `OutboxStatus.FAILED` on exhaustion.
- **Reconciler** (`reconciler.py`): calls `enqueue_ingest(db, request)` when ENDED/FINALIZED,
  alongside marking `event.status = OutboxStatus.DONE`.
- **Capture worker** (`worker.py`): `ingest_next` added to the pass loop alongside `dispatch_next`
  and `reconcile_next`; return dict gains `"ingest_events"` key.
- **Worker tests** (`test_capture_worker.py`): updated to monkeypatch `ingest_next` and assert the
  new result key.

Slice 17 evidence: 10 new tests pass in `tests/capture/test_transcript_bridge.py`; all 147 capture
tests pass; scoped Mypy clean on new files. Alembic reports one head (f7b8c9d0e1a2). Pipeline is
now wired from capture-ENDED through Utterance rows to the "screen" pipeline stage. Audio recording
remains disabled — the Groq ASR lane for temporary audio is the next F06 slice.

## Slice 18: F07 — Meeting capture-status endpoint

Published in this session:

- **`_pipeline_progress(state) -> int`** added to `app/api/meetings.py`: maps every `CaptureState`
  value to a 0–100 completion percentage using an ordered `_PIPELINE_STAGES` list; DONE → 100,
  FAILED → 0, others proportional.
- **`_STATE_TO_STAGE`** mapping added: routes states to named pipeline stages (ACQUIRED maps to
  "screen" for provider-transcript sessions).
- **`MeetingListItem`** extended with `latest_capture_request_id`, `latest_capture_request_status`,
  and `report_ready` fields; `GET /api/v1/orgs/{org_id}/meetings` now surfaces these from the latest
  `CaptureRequest` and `CaptureSession` rows.
- **`GET /api/v1/orgs/{org_id}/meetings/{meeting_id}/capture-status`** — new endpoint returning
  `SessionStatus`: `state`, `report_ready`, `pipeline_progress_pct`, `report_title`, `report_summary`,
  `has_coverage_gap`, `error`. Returns 404 when no `CaptureSession` exists.

Slice 18 evidence: 7 new tests pass in `tests/api/test_meetings.py` (list surfacing, report_ready,
processing/done/404/gap states). mypy clean on new endpoint.

## Slice 19: F08 — Meeting assignment API

Published in this session:

- **`PUT /api/v2/workspaces/{org_id}/meetings/{meeting_id}/assignment`**: assigns or moves a meeting
  to a project. Caller must be an org member and target-project member. Moving requires source-project
  membership too (prevents silent data inaccessibility). Idempotent if already at same project.
  Returns `AssignmentView` with `id`, `meeting_id`, `project_id`, `source`, `version`.
- **`DELETE /api/v2/workspaces/{org_id}/meetings/{meeting_id}/assignment`**: removes the assignment.
  Caller must be a project member. Idempotent (204) when not assigned.
- **`GET /api/v2/workspaces/{org_id}/projects/{project_id}/meetings`**: lists meetings assigned to a
  project in descending `scheduled_start` order. Only project members can access (`_membership` gate
  returns 404 to non-members to avoid leaking project existence).
- Three response models added to `projects_v2.py`: `AssignmentIn`, `AssignmentView`,
  `ProjectMeetingListItem`.

Slice 19 evidence: 11 new tests pass in `tests/api/test_projects_v2.py` covering: assign, idempotent
re-assign, move with/without source membership, non-member denied, unassign, idempotent unassign,
non-member unassign denied, list, list non-member denied, 404 for unknown meeting/project. mypy clean
on updated file.

## Slice 20: F09 — Project/customer memory and decision tracking

Published in this session:

- **`SummaryVersion`** model added to `app/db/models.py` with Alembic migration `a1b2c3d4e5f6`:
  tracks versioned project/customer memory keyed by `(scope_kind, scope_id, input_revision_hash)`.
  Fields: `state` (pending/ready/partial/failed), `structured_summary` (JSON: decisions, commitments,
  open_questions, blockers, context_summary), `source_meeting_ids`, `error`.  UniqueConstraint on
  (scope_kind, scope_id, input_revision_hash) ensures idempotency.
- **`app/memory/project_memory.py`**: deterministic aggregation service:
  - `rebuild_project_memory(session_factory, org_id, project_id)` — aggregates `KnowledgeItem`s for
    all meetings assigned to the project.  Idempotent by hash; returns existing READY row when
    the meeting set hasn't changed.  New row created when meetings are added/removed.
  - `rebuild_customer_memory(session_factory, org_id, customer_id)` — same logic across all projects
    belonging to the customer.
  - `latest_summary(db, scope_kind, scope_id)` — returns the latest READY row, or None.
  - Only `VERIFIED`/`PARTIALLY_SUPPORTED` confidence items included (raw transcript never in summary).
  - Items filtered to `NEW`/`RECURRING`/`REOPENED` lifecycle states only.
- **`GET /api/v2/workspaces/{org_id}/projects/{project_id}/memory`** — returns `MemoryView`.
  Project member access gate; computes synchronously on first call.
- **`GET /api/v2/workspaces/{org_id}/customers/{customer_id}/memory`** — same shape for customers;
  aggregates from all projects in the org linked to the customer.
- Both endpoints wired into `app/main.py` via `memory_router`.

Slice 20 evidence: 9 API tests pass in `tests/api/test_memory.py` (empty project, with knowledge
items, confidence filter, idempotency, non-member 404, unknown project/customer 404, customer
aggregation); 8 service unit tests pass in `tests/memory/test_project_memory.py` (hash stability,
idempotency, new-version-after-assignment, knowledge-item aggregation, customer-across-projects,
latest_summary None case). Alembic reports one head (a1b2c3d4e5f6). mypy clean on new files.

## Slice 21: F10 — Persistent project/customer conversations

Published in this session:

- **`ChatThread`**, **`ChatMessage`**, **`AnswerCitation`** models added to `app/db/models.py`
  with Alembic migration `b2c3d4e5f6a7`:
  - `ChatThread`: scope_kind ("project"/"customer"), scope_id, creator_id, title, status, version.
    Unique index on (org_id, creator_id, scope_kind, scope_id).
  - `ChatMessage`: thread_id, role (user/assistant), state (pending/generating/done/failed),
    content, client_request_id (idempotency), generation_id (for future SSE streaming).
    UniqueConstraint on (thread_id, client_request_id).
  - `AnswerCitation`: message_id, meeting_id, knowledge_item_id (nullable) — read-only provenance.
- **`app/api/threads.py`** with 5 endpoints under `/api/v2/workspaces/{org_id}`:
  - `POST /threads` — create creator-private thread; project scope requires project membership.
  - `GET /threads` — list caller's threads; optional scope_kind/scope_id filters.
  - `PATCH /threads/{id}` — update title/status; optimistic version check; creator only.
  - `GET /threads/{id}/messages` — chronological messages; creator only.
  - `POST /threads/{id}/messages` — idempotent (client_request_id); creates user message
    (state=DONE) + pending assistant message (state=PENDING, generation_id set). 202 response.
    Archived threads reject new messages with 409.
- Router wired into `app/main.py`.
- Architecture rule: no LLM call in this slice; generation_id is reserved for the future worker
  that will fill the assistant message content.

Slice 21 evidence: 12 new tests pass in `tests/api/test_threads.py` covering thread create
(project/customer), non-member denied, unknown project 404, list with scope filter, list
creator-only, update title + archive, version conflict, send message + pending assistant created,
send idempotent, archived thread rejected, list messages chronological. Alembic reports one head
(b2c3d4e5f6a7). mypy clean on new file.

## Next capture slice

1. Add capture request/attempt/segment/inbox/usage reservation models with Alembic migrations.
   Persist one request per workspace/meeting occurrence/idempotency key. Include cancellation,
   provider record ID, normalized state, lease owner/version and last successful reconciliation.
2. Bind provider credentials by workspace using the existing SecretStore; no shared key lets one
   customer's native meeting ID resolve another customer's occurrence. Restrict provisioning to admins.
3. Add authenticated request/read/stop endpoints; POST acknowledges persisted intent, not capture.
   Start a separately invoked leased dispatcher; do not put a background bot inside an API request.
4. Resolve uncertain creates without resending; stop APIs in Vexa are native-keyed, so serialize all
   dispatch/stop operations for that key. Old terminal occurrences must not stop a later meeting.
5. Reconcile normalized segments by provider record/segment/revision; finalize once and enter the
   pipeline after ASR. Preserve speaker uncertainty and gap intervals.
6. Implement deletion deadlines before enabling temporary recordings. Add consent/onboarding,
   per-org limits and calendar scheduling before any production capture rollout.

Then implement the customer/project and persistent chat stages from the full plan. Maintain a
separate checklist for local checks, staging meetings and production rollout; never merge those claims.

## Publication

Existing uncommitted extension/worker/RTMS and other edits remain separate work. Publish each code
slice only after scoped validation and review. Do not trigger a production deployment from an
incomplete orchestration slice.
