# System audit, corrective slice and continuation

Updated: 2026-10-08. Base reviewed: `32a898f` on `codex/founder-platform-plan`.
Repository: [visualsprint-core](https://github.com/thanoban/visualsprint-core).

## Read this first

The current plan is [PROJECT_PLAN](PROJECT_PLAN.md) and documents 18, 20–24. This audit is a
progress/continuation record, not permission to replace their product decisions. Earlier claims
that numbered slices were published describe code/API foundations, not completed F00–F14 features.
The full founder product is **not ready for production or a Fathom-parity claim**.

Preserved decisions: unattended capture; English-first; private projects and creator-private chats;
no permanent recordings/screenshots; temporary audio at most 24 hours only after deletion is
qualified; modular monolith with separate workers; human approval before external writes.
No paid resources, production migrations, OAuth settings or deployments were changed in this audit.

Scope inspected: current specification, API/auth routes, customer/project memory, assignment,
calendar scheduler, capture requests/dispatcher/reconciler/transcript bridge/worker, processing
boundaries, proposal approval, usage/export/deletion contracts, frontend routes, migrations,
test fixtures and CI/deploy triggers. This is not live platform qualification or an exhaustive
security certification. Do not substitute passing mock-provider tests for an actual meeting.

## What “like Fathom” currently means

Official public sources checked 2026-10-08:

- [Product overview](https://www.fathom.ai/overview): summaries/actions, dictionaries, live notes,
  cited account-wide questions, trackers, integrations and capture choices. Its default automatic
  joining is tied to the user joining/starting a meeting; our unattended requirement differs.
- [Fathom 3.0 upgrade guide](https://help.fathom.video/en/articles/11577345): phased availability
  and capture-mode details. Do not assume every account/OS has every announced capability.
- [Account-wide Ask Fathom](https://help.fathom.video/en/articles/10390017): cross-meeting questions
  remain bounded by accessible meetings.

We can implement comparable workflows; these pages do not reveal Fathom's private architecture,
provider arrangements, operating cost or measured reliability. Do not copy its branding or claim
competitors lack customer context merely because our product emphasizes it.

| Public workflow | VisualSprint actual state / release decision |
|---|---|
| Calendar-driven meeting capture | OAuth/occurrence foundations; scheduler still uses legacy capture paths, not the durable v2 request lane |
| Transcript, summary and actions | Existing pipeline and report views; provider transcript ingest exists, live end-to-end capture unqualified |
| Cited questions across history | Legacy retrieval exists; permissions hardened; saved v2 replies lack a generation worker |
| Dictionaries and corrections | Legacy glossary/correction paths exist; source-version propagation is not completely wired |
| Live summaries/notes | Capture state is not a live summarizer; live summary/scratchpad/mention experience absent |
| Recording playback, clips, bot-free desktop | Deliberately outside the current text-only unattended pilot, not implemented parity |
| CRM, trackers, public API/MCP experience | Selected connector foundations only; complete connector catalogue, trackers and product-level MCP not delivered |
| Founder-specific customers/projects/chats/agendas | Schema/API foundations; customer/project/chat/agenda frontend and full lifecycle still required |

Full literal parity would require a separate explicit scope decision for desktop/mobile, permanent
media, sharing/clips, additional languages and wider integrations. Do not silently add these to a
budget-constrained pilot. First deliver the reliable core loop and the approved founder additions.

## Corrections implemented in this audit

### Private sources and revocation

- Added shared `app/modules/projects/access.py`: permitted-meeting filtering happens in SQL before
  retrieval/limits. Assigned meetings require explicit project membership, not merely workspace admin.
- Reused policy in legacy meeting/session/report/transcript routes, chat retrieval and graph
  expansion, corrections/speaker edits, action list/approval, failed-job requeue, data-rights meeting
  operations and linked calendar/agenda/capture routes. Readers cannot edit project meetings.
- Graph expansion and evidence links are workspace/session scoped; malformed cross-meeting evidence
  does not render another meeting's transcript or screenshot in a report.
- Customer memory resolves the current reader's permitted projects **before** cache lookup. Removed
  the global “latest customer summary” shortcut and request-session-closing factory hack.
- Memory cache revision now includes source content/evidence/coverage, not just meeting IDs. A later
  processing result or correction creates a new memory revision rather than serving empty/stale data.
- Project threads recheck scope access on every operation. Existing generated text is hidden as a
  read projection if a cited source is no longer accessible/in scope; persisted text is not overwritten.
- Thread edits and sends refresh the thread under a row lock before checking version/archive state;
  a stale ORM copy cannot overwrite a concurrent edit or append to an already archived thread.
- Assignment requires the meeting owner and target owner/editor, rejects archived targets and
  serializes assignment/last-project-owner operations. A workspace role does not grant private content.
- Legacy people/longitudinal and glossary views lack complete source provenance. They now fail closed
  for a workspace reader with inaccessible meetings rather than exposing aggregate text/counts.
  This includes workspace admins with no private-project membership. Authorized source-specific
  project/customer memory remains available. These compatibility views still need source-aware
  replacements and historical erasure/invalidation qualification.

Compatibility exception: historical ownerless, unassigned meetings retain legacy workspace access
only while the pilot flag is false. When the pilot is enabled they are quarantined. Before rollout,
backfill defensible ownership and audit remaining legacy derived routes; do not guess owners.

### Capture truth and bounded processing

- Transcript ingest claims are fenced. A reclaimed worker cannot publish or overwrite a newer
  worker's result. Final provider identity/state are checked before ingest.
- Empty/all-blank or draft-only results are not published as successful sessions. Retryable final
  transcript unavailability has bounded retries; invalid identity/payload is a visible failure.
- Non-final/empty spans are missing coverage, low-confidence spans degraded coverage.
- Omitted ASR confidence remains `NULL`, not invented 100%. Provider speaker labels remain unverified
  identities with attribution confidence zero. Nullable confidence is reflected in API/frontend types.
- The provider-transcript pilot enters understanding directly; it does not run screen collection.
- Transcript freshness advances only on a new transcript revision, not every successful poll.
  Only the digest is persisted in the capture attempt, not a second raw transcript copy.
- Reconciliation rejects mismatched provider identities and cannot resurrect terminal attempts.
  Four-hour capture timeout uses attempt lifetime, not a reconnect-reset state timer.
- Successful polls reset the consecutive error budget: a long healthy meeting does not exhaust
  the retry budget for its first later provider outage.

### Idempotency, usage and agenda consistency

- Capture creation serializes workspace quota accounting and checks ownership/current read access.
  Identical retries return the existing request before re-evaluating budget/policy; changed payloads
  remain conflicts. Current-month active reservations and reconciled values are accounted for.
- Usage converts `bot_second` reservations to minutes; an actual value of zero stays zero instead of
  falling back to an estimate. Pre-dispatch cancellation releases reserved quota.
- Reusing a chat client request ID with different text returns 409. History responses are bounded.
- Agenda generation reads current permitted memory, allocates increasing versions and returns the
  latest objective. Linked private occurrences cannot expose or mutate agendas to unauthorized users.
- Workspace export/deletion jobs reject a different workspace supplied as `scope_id`.
- A narrow calendar sync does not cancel occurrences outside its queried window. An authoritative
  reappearance restores a cancelled occurrence to scheduled state.
- Fixed lint/import issues and a swallowed immutability-test assertion. Overlength test-user IDs were
  replaced by valid UUIDs; action fixtures now persist the referenced user for PostgreSQL FK validity.

### Migration

`h9b0c1d2e3f4` follows `g8a9b0c1d2e3`:

1. Makes `utterance.asr_confidence` nullable.
2. Adds nullable `capture_attempt.transcript_revision_hash VARCHAR(64)`.

`i0c1d2e3f4a5` then corrects `ck_action_requires_approval`. SQLAlchemy persists enum names such as
`APPROVED`, while the old constraint checked only lowercase strings, silently allowing unapproved
ORM writes. The new check handles both forms and requires the actor and approval timestamp.
Approval/rejection serialize on the action row. An invited member's authenticated user ID can create
their workspace Person link; no transcript label/email match is used to guess their identity.

One Alembic head and PostgreSQL offline SQL generation were verified. A separate local PostgreSQL
container was created after Docker became available; no existing application database was used.
Full-chain upgrade, seeded confidence preservation, downgrade/re-upgrade and the approval migration
were rehearsed there. The confidence downgrade replaces unknown values with zero and loses the
digest: export first; do not call rollback lossless. The approval downgrade deliberately retains the
stronger constraint because the preceding schema already supports both approval columns.

Existing approved/executed rows lacking actor/timestamp **block** the approval migration. A seeded
invalid historical action caused the expected constraint failure and left the migration version
unchanged. Reconcile real historical rows from genuine approval/audit evidence before deployment;
do not auto-approve, fabricate timestamps, discard rows or weaken the check. No production migration
was attempted. `create_all` unit tests alone do not test historical data migration.

## Feature acceptance audit

| Feature | Real implementation | Still needed before feature acceptance |
|---|---|---|
| F00 baseline | Plan branch, local checks, full PostgreSQL backend run and migration rehearsal, CI configuration | Track whole-app typing debt separately and qualify production durability; branch push is not a CI run |
| F01 identity/onboarding | Existing JWT/OAuth, workspace roles, disclosure/preferences, refresh tests | Complete workspace/member UI, invitation flows and production session qualification |
| F02 customers/projects | CRUD/member/archive APIs; private meeting policy | Customer/contact/project/timeline UI, complete contact rules and metadata visibility review |
| F03 calendars | Connections, normalized occurrence/override APIs and legacy sync | Owner identity migration, selected calendars, cursor/push renewal, durable v2 scheduling, cancellation/reschedule of jobs |
| F04 capture requests | Provider port/binding, outbox, reservations, idempotent dispatcher | Pinned provider deployment and real admission matrix, measured five-bot account isolation/concurrency |
| F05 live capture | Polling/freshness/stop intent, leases, timeouts, terminal handling | Verified stop/create native-key races, empty-room grace, provider outage/restart/overrun and user-facing v2 status wiring |
| F06 transcript/retention | Fenced final transcript bridge, uncertainty/gap handling, media deletion module | Draft/final durable revision reconciliation, qualified STT lane, deletion-worker invocation and provider/storage deadline proof |
| F07 report/correction | Existing supported-claim pipeline, transcript/report UI and corrections | Versioned report publication before optional analytics, canonical correction invalidation, real English quality/latency evaluation |
| F08 assignment/history | Owner/editor assignment APIs and archive checks | Move picker/timelines, optimistic conflict token, source/target invalidation events and confirmed matching rules |
| F09 memory | Reader-specific deterministic supported-claim aggregation with revision cache | Incremental invalidation, decision chronology/supersession/contradiction views, bounded large-history strategy |
| F10 saved chat | Private thread/message APIs, access rechecks, idempotent sends | Generation outbox/worker, real LLM/embedder factories, persisted citations/source revisions, streaming/pagination and UI |
| F11 agendas | Authorized on-demand sections and increasing generated versions | Immutable edited versions, merge/proposal conflict handling, 24h/15m scheduler/reschedule, frontend editor |
| F12 integrations | Approval/hash contract and existing connector implementations | Leased execution/reconciliation worker, destination UI, immutable approval snapshots and live duplicate-write tests |
| F13 usage/data rights | Usage projection, quota reservation, export/deletion job APIs | Actual provider-runtime reconciliation, export/deletion workers, privacy cascades and capture/connection diagnostics |
| F14 pilot | Workspace flag and monthly-minute cap | Entire real founder scenario, five-call/four-hour soak, outage/cleanup/cost measurements and rollout approval |

Do not turn API foundations into completed feature checkboxes. In particular:

- `app/capture/worker.py` is a bounded pass and must be repeatedly invoked by an operator-controlled
  runner. A single CLI invocation is not an always-on scheduler. It dispatches, reconciles and ingests;
  it currently does not run temporary-media deletion.
- `app/orchestrator/scheduler.py` still creates legacy A2/session or optional guest-bot work. Do not
  assume the existence of CalendarOccurrence plus CaptureRequest tables connects these paths.
- `POST /threads/{id}/messages` stores a pending assistant row. No generation consumer/stream route
  currently finishes it. The old frontend chat is not the new saved-chat product.
- Legacy chat defaults to a deterministic supported-item list when its optional LLM dependency is
  absent. That is not a configured conversational AI; wire production factories and an explicit
  unavailable state in F10 rather than presenting this compatibility response as AI parity.
- Export/deletion 202 responses mean persisted intent, not an exported file or completed erasure.
- The frontend build still exposes legacy meetings/upload/chat/settings pages, not founder customer/
  project workspaces. A compiled page is not acceptance of F02/F08/F10/F11.
- Legacy people/longitudinal/glossary compatibility views now reject source-restricted readers;
  source-aware replacements, historical erasure/invalidation and old source-free assistant rows
  still require qualification before private founder workspaces are enabled.

## Verification evidence

Local evidence recorded separately from live qualification:

- First affected suite: 448 passed, one skipped.
- Final broader local suite excluding three PostgreSQL-dependent files: 868 passed, one skipped.
  Follow-up policy/UUID fixture suite: 129 passed. Last capture/chat/privacy sweep after the
  consecutive-error-budget correction: 61 passed, one vector-search test skipped.
- Final focused capture/scheduler/privacy/action/report suite: 101 passed.
- Full backend suite with the disposable PostgreSQL URLs: **893 passed, one skipped**, 751.08 seconds.
  Includes real pgvector ordering, bounded worker/upload FSM and separate-transaction capture quota/
  idempotency races. STT, diarization and model responses remain test doubles, not live provider proof.
  The final legacy-aggregate/thread-lock follow-up is recorded separately below; it is not silently
  included in that earlier suite's count.
  The skipped case is the historical SQLite structural vector placeholder in `test_chat.py`;
  actual PostgreSQL cosine ordering passed in `test_vector_search_postgres.py`.
- Final PostgreSQL follow-up across actions v1/v2, adversarial access, people, corrections and threads:
  **95 passed**, 170.02 seconds. Includes restricted-admin legacy-view denial, authenticated actor
  creation without same-email identity guessing, direct approval-check violations, concurrent quota/
  idempotent requests and concurrent stale-copy thread edits (one update wins, one version conflict).
- Final Ruff and scoped typing checks passed after these follow-up corrections. Existing Starlette/
  httpx deprecation warning remains; it did not fail these checks.
- Ruff: all app/tests checks passed; strict scoped mypy: 13 changed boundary files clean.
- Repository mypy gate passed: interface/agent/database/auth modules clean; whole-app debt is 216
  errors in 50 files, down from the allowed 218. Baseline lowered, not raised. A bare `mypy app`
  is therefore still red: the gate deliberately ratchets existing debt, not full typing completion.
- Frontend: lint, TypeScript and production build passed, 17 routes generated.
- Legacy extension: four tests passed; this is compatibility evidence, not a primary capture release.
- Frozen agent evaluation gate passed on eight synthetic fixtures and zero real-meeting samples;
  it is a format/regression gate, not measured language accuracy or a live model evaluation.
- PostgreSQL was initially blocked by Docker's unavailable engine; that interrupted attempt is not
  counted as a pass. After the user enabled Docker, created only `visualsprint-audit-postgres-20261008`,
  bound to `127.0.0.1:55433`, with separate disposable migration/application/API-test databases.
- PostgreSQL caught user/member fixture flush ordering errors SQLite had hidden. Fixtures now persist
  users before dependent rows; foreign-key enforcement was not disabled. The first failed run stopped
  at 114 passed / five fixture failures and is not a successful full suite.
- Migration rehearsal preserved an existing confidence of 0.83, accepted NULL, conservatively mapped
  NULL to zero on rollback, then re-upgraded. The new approval check also passed upgrade and rejected
  an invalid historical row atomically. Tests include direct ORM approval-check violations.
- To reduce schema-rebuild time, disk-sync settings were disabled **only** on the disposable test
  container (`fsync`, `synchronous_commit`, `full_page_writes`). Functional/locking results from it
  do not prove crash durability, production storage reliability or restart recovery. Existing
  containers and their settings were untouched.
- Restored those disk-sync settings after the tests and stopped the owned audit container. Its
  anonymous volume and disposable databases are retained for recovery; no existing container,
  database, volume or user scratch log was deleted.
- Broken generated `.next/dev/types` files were recoverably moved under `.next/archived-dev-types-20261008`;
  no source or user data was deleted. TypeScript and Next build subsequently passed.

Never run tests that drop/create tables against a production database. API test fixtures rebuild
their database. Use a disposable `visualsprint_test` database and review all environment variables.

## Continue in this order

1. **F00/F01/F02 privacy release gate:** complete database/quality qualification and audit historical
   approvals before migration; finish private-source policy coverage, defensible
   meeting/calendar ownership, member-removal cleanup and versioned source invalidation.
2. **F03–F06 core vertical slice:** one consented manual link through pinned provider, durable request,
   real admission, transcript until host end, normalized partial/final status, verified report and
   stop confirmation. Connect calendar occurrences to that same request service, not a second bot
   transport; cancellation/reschedule must update pending work. Repeated worker invocation and
   deletion sweeps must be explicit. Never retry an uncertain provider create blindly.
3. **F07/F08 usable UI:** switch the capture UI to v2 status and explicit supported-policy messaging;
   finish customer/project workspace, assignment, meeting detail/timelines and report-first processing.
4. **F09/F10 memory and conversations:** generation jobs with leases/retry identity, authorization
   before retrieval and again before publication, bounded history, source revision citations, honest
   model-outage state and saved-thread UI. No canned assistant answer or permanent PENDING placeholder.
5. **F11/F12/F13 lifecycle:** edited agenda versions/scheduled preparation, approved connector execution
   reconciliation, actual usage, durable exports, cascading deletion and cleanup audit receipts.
6. **F14 qualification:** real Meet/Zoom/Teams policies supported by the pinned provider, absent-founder
   case, admission denial, everyone-left/host-end, overrun, five concurrent calls, four-hour soak,
   restart/outage, customer isolation, deletion deadline and actual spend/latency. Only then enable
   the workspace pilot flag and describe supported platforms publicly.

Keep the modular monolith. Move new logic behind `app/modules/*` ports rather than creating a router
that imports another router's policy. No microservice split is justified by the current evidence.
Keep provider adapters replaceable. Do not disable platform admission controls, make all customer
meetings public, or reintroduce recurring Google-cookie upload as the normal solution.

## Fast local checks (PowerShell)

```powershell
cd D:\PROJECTS\Startup\MeetForge\backend
.\.venv\Scripts\python.exe -m ruff check app tests
.\.venv\Scripts\python.exe -m scripts.mypy_gate
.\.venv\Scripts\python.exe -m pytest tests/api/test_founder_plan_regressions.py tests/capture/test_transcript_bridge.py tests/capture/test_reconciler.py tests/orchestrator/test_scheduler.py -q
.\.venv\Scripts\python.exe -m pytest tests -q --ignore=tests/orchestrator/test_worker_bounded_pass.py --ignore=tests/test_upload_pipeline.py --ignore=tests/test_vector_search_postgres.py
.\.venv\Scripts\python.exe -m alembic heads
.\.venv\Scripts\python.exe -m alembic upgrade g8a9b0c1d2e3:head --sql
cd ..\frontend
npm run lint
npm run build
cd ..\extension
npm test
```

The exclusion command is a local fallback, not a replacement for PostgreSQL CI. For real capture,
use an explicitly consented test meeting and prove request/attempt IDs, actual participant admission,
new timed text, end/stop acknowledgement, report citations and absence of retained media. A green
queued banner or provider HTTP 200 alone proves none of these outcomes.

Publication: stage only the audit's source/test/doc paths. Preserve `.codex-log-89201470964/` scratch
files and any unrelated edits. Push this plan branch without merging to `main`: the deploy workflow
is main-triggered, while quality runs on PR/main/manual/reusable triggers. A plan-branch push alone
does not establish a green GitHub Actions run or a production rollout.

Security follow-up: rotate any still-active provider secrets previously pasted into chat. Do not
copy them into this report, fixtures, environment examples or Git history.
