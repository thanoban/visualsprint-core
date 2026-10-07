# Engineering design and target code structure

Status: APPROVED TARGET DESIGN. Updated 2026-10-07. Incremental implementation is active.
Read [18: architecture](18-founder-platform-architecture.md) and
[21: feature delivery](21-feature-delivery-plan.md) together with this document.

## 1. Engineering approach

Build a modular monolith, not a distributed collection of CRUD services. The API, scheduler,
integration worker and analysis worker are separate entry points sharing typed application services
and PostgreSQL. Capture runs in an isolated Vexa deployment. A module owns its rules and tables;
other modules use its application interface rather than updating its rows ad hoc.

Retain Python/FastAPI, SQLAlchemy/Alembic, Next.js/TypeScript, PostgreSQL/pgvector and existing
authentication. Keep locked dependencies; check supported frontend peer-dependency combinations
before the first UI implementation. Do not upgrade libraries as a side effect of unrelated features.
No new broker, Kubernetes, graph database or self-hosted large language model for the pilot.

Every feature is a vertical slice: schema migration, application behavior, API, minimal UI,
authorization, tests, telemetry and documentation. Complete one coherent slice before adding
the next. A working button and fake response are not an implemented feature.

### Dependency rules

1. Domain code uses standard Python and small typed value objects. It imports neither FastAPI,
   SQLAlchemy, HTTP clients nor vendor SDKs.
2. Application services coordinate domain rules through typed repositories and provider ports.
3. HTTP handlers authenticate, validate, call an application service and translate its result.
   They do not launch background coroutines, issue provider requests or implement business workflows.
4. Infrastructure adapters implement ports. Vendor DTOs and errors stop at that boundary.
5. Jobs invoke the same application services as HTTP commands. One operation has one implementation.
6. Cross-module effects are transactional outbox events. A synchronous read of another module's
   authorized projection is allowed; direct cross-module table mutation is not.
7. No generic repository framework, service locator, dynamic agent registry or inheritance hierarchy
   unless a second real use case establishes the need. Prefer explicit composition and small functions.

## 2. Target repository layout

This is the migration destination, not a request to move all existing files in one commit.

```text
backend/
  app/
    main.py                         # HTTP composition only
    bootstrap.py                    # factories, configuration validation, provider wiring
    modules/
      identity/                     # workspace, membership, authorization policy
      customers/                    # customer/contact records and confirmed matching rules
      projects/                     # projects, access, meeting assignments
      calendars/                    # connections, event occurrences, sync cursors
      capture/                      # requests, attempts, state transitions, reconciliation
      transcripts/                  # revisions, timing, speaker labels, corrections, gaps
      knowledge/                    # extraction, verification, summary and memory versions
      conversations/                # threads, messages, retrieval scope and citations
      agendas/                      # generation, editing, scheduling, source freshness
      integrations/                 # proposals, approvals, execution and reconciliation
      usage/                        # reservations, metering, quotas and spending policy
      data_rights/                  # retention, deletion and export orchestration
        domain.py                   # within each module: pure rules and value types
        schemas.py                  # command/result types and DTO validation
        service.py                  # explicit application operations
        repository.py               # module persistence operations
        api.py                      # thin authenticated endpoints, if module exposes HTTP
        jobs.py                     # typed job handlers, only where needed
    interfaces/                     # provider ports: capture, ASR, LLM, calendar, secrets
    adapters/                       # Vexa, Groq, Gemini, Google/Microsoft implementations
    infrastructure/
      jobs/                         # leases, outbox, retry and dead-letter mechanics
      security/                     # secret resolution and signature verification
      observability/                # structured logs, metrics, traces
    db/
      base.py
      models.py                     # compatibility registry for all mapped tables
    entrypoints/
      scheduler.py
      capture_worker.py
      analysis_worker.py
      integration_worker.py
  alembic/versions/
  tests/
    unit/<module>/
    integration/<module>/
    contracts/<provider>/
    acceptance/
  evaluation/                       # labelled transcript and answer-quality evaluation
frontend/
  app/
    (authenticated)/
      meetings/                     # upcoming, live, past; meeting detail and report
      customers/[customerId]/
      projects/[projectId]/
      chats/[threadId]/
      actions/
      settings/                     # connections, members, capture policy, usage, retention
  features/
    capture/ customers/ projects/ conversations/ agendas/ actions/
  components/                       # accessible shared UI primitives
  lib/
    api/                            # typed client, errors, request IDs, SSE parsing
    auth/                           # current session and refresh coalescing
infra/
  local/                            # isolated local application services
  capture/                          # reviewed, pinned provider deployment description
  deploy/                           # environment-specific rollout manifests
docs/
  PROJECT_PLAN.md                    # current index, precedence and implementation gate
  18-*.md through 24-*.md            # current design, contracts, delivery and operations
```

Do not create empty files or move stable legacy modules simply to match this tree. New slices go
into their owning module; legacy facades delegate until all callers have migrated. Keep model
registration discoverable through `app/db/models.py` so migrations and existing tests see one schema.

## 3. Module responsibilities

| Module | Owns | Does not own |
|---|---|---|
| Identity | Workspace and role checks, capability decisions | Provider admission or LLM decisions |
| Customers | Contacts, customer identity, approved matching | Guessing identity from a shared email domain |
| Projects | Private membership and meeting assignments | Capture transport or billing |
| Calendars | Provider event instances, cancellations, cursors | Running a bot itself |
| Capture | Dispatch intent, attempts, state, stop/reconcile | Transcript interpretation |
| Transcripts | Canonical timed text, revisions, speaker uncertainty | Inferred business conclusions |
| Knowledge | Verified claims, temporal links, summary versions | Raw media lifecycle or external writes |
| Conversations | Persistent conversation and scoped evidence retrieval | Permission expansion through prompts |
| Agendas | Versioned next-meeting preparation and edits | Sending invitations without approval |
| Integrations | Approved side effects and execution results | Independent auto-approval |
| Usage | Usage ledger, reservations, admission limits | Silently ending an active call at a cost estimate |
| Data rights | Deletion and retention progress | Claiming provider backups were erased without evidence |

## 4. Capture request lifecycle

1. Resolve the authenticated actor/workspace; validate a supported HTTPS invitation URL.
2. Resolve capture policy, disclosure requirements and calendar occurrence. Users can select a
   project; otherwise preserve Unassigned ownership until a confirmed matching rule applies.
3. In one transaction: claim request idempotency, reserve usage/concurrency, create capture intent
   and write a dispatch outbox event. Return 202 with the persisted ID and queued state.
4. Dispatcher acquires a short renewable lease and resolves the workspace's provider credential.
   Commit before provider I/O. Store the attempt identity before sending POST /bots.
5. A documented provider acceptance attaches its immutable record ID. A timeout/ambiguous response
   marks dispatch_unknown; reconcile it. Never resend POST simply because a network retry is convenient.
6. Provider events/polls produce normalized transitions. Joined/active state and transcript freshness
   are separate. Persist capture gaps; retain state history for diagnosis.
7. Stop is a durable request. Serialize stop/start by provider-account/native-meeting key because Vexa
   stop is native-keyed. Confirm the old record is not terminal/newer before sending stop.
8. Ending triggers final transcript reconciliation. Processing continues independently. Cancelled,
   blocked and partial results have distinct user-facing outcomes.

Webhook fast path: verify signature and timestamp from the pinned provider contract, enforce body
size, insert unique inbox event and return promptly. A worker applies it; stale events cannot reverse
a terminal state. If provider signing is unavailable, do not expose an unauthenticated webhook;
use authenticated polling until a verified event transport exists. Capture reconciliation polls active
records every ten seconds for the pilot, with jitter/backoff and bounded provider concurrency.

## 5. Processing graph and latency

```text
segment persisted -> normalize timing + transcript revision
final transcript -> extract candidates -> verify against evidence -> publish meeting summary
                                                           |-> update project/customer memory
                                                           |-> prepare action proposals
                                                           |-> refresh affected agendas
```

The summary does not wait for all integrations, historical analysis or person analytics. Qualified
provider transcripts skip file transcription and diarization. Audio-only capture takes the tested
ASR path first. Do not run every provider and compare every model on every meeting by default.

Job uniqueness is `(workspace, entity, operation, input_revision)`. Claim/commit before I/O,
renew the lease while working and check the fencing version when publishing. Two workers may
compute after a crash but only the current owner may commit; downstream effects have their own
idempotency keys. Store external-call usage even when generation fails.

Use separate capture/scheduling and analysis queues. Pilot defaults: maximum five active captures
overall, two analysis jobs per workspace and four overall. Cap provider/model requests separately.
Scale limits remain configuration, with test coverage for reservation races and fairness.

## 6. Knowledge and conversation design

Extraction produces atomic typed candidates: decision, commitment, question, requirement, risk or
blocker; each names transcript segment revisions and times. Verification labels supported,
partially_supported, ambiguous or unsupported using evidence, without extractor reasoning.
Unsupported claims are excluded from factual summaries. Uncertain ownership/dates stay null.

Report rendering consumes verified statements and citations, not unrestricted transcript text.
Chat may search transcript chunks for recall, but factual answer claims must pass the same evidence
validation before delivery. This prevents the verified-knowledge index from hiding relevant passages
that extraction missed while retaining source discipline.

Use hierarchical summaries: meeting -> project -> customer. Keep original source references through
every aggregation. Incrementally update affected versions; never recursively summarize AI text without
recoverable sources. "All meetings" questions enumerate the authorized scope and report coverage;
ordinary question answering uses top-k retrieval plus temporal neighbors within the same permission set.

Persist user and assistant messages. Thread scope is fixed at creation; changing scope creates a new
thread. Store the source-set revision for each answer. A deleted/revoked source makes an old citation
unavailable and invalidates affected cached answers; users must not recover hidden content through
old assistant text. Access is checked when listing a thread and when expanding every citation.

## 7. Frontend conventions

- One typed API client; no component constructs backend origins or reads provider credentials.
- Keep URL-driven project/customer/thread selection; durable state lives server-side, temporary
  input and loading states locally. Avoid duplicate caches with conflicting ownership.
- Split pages into feature components; shared primitives handle buttons, dialogs, tables and notices.
- Show loading, empty, permission denied, reconnect, partial and failed states explicitly.
- Disable duplicate mutations while pending; preserve user input on failure and support retry.
- SSE reconnect uses an event cursor; HTTP polling is the fallback. Reconnection is not a new capture.
- Never display mock data as a successful production response. Demo mode is an isolated explicit mode.
- Accessible labels, keyboard focus and status announcements are acceptance requirements.

## 8. Coding and review standard

No bare exceptions that hide errors; translate known failures into stable domain codes. No secret,
raw transcript, full invitation URL or prompt body in routine logs. No `Any`/`object` as a substitute
for an application contract; use typed provider schemas and strict boundary validation.

No long SQL transactions around model/provider calls. No unbounded lists of meeting audio, unbounded
task spawning, whole-history prompt concatenation or module-global mutable capture state. No retry
on non-idempotent external writes without reconciliation. No hardcoded user/company/provider IDs.

Every PR/slice records the user behavior, authorization boundary, migration/rollback, affected tests,
operational metrics and verified/unverified limits. New code passes lint/type checks without raising
the historical error baseline. Tests prove behavior and failure recovery, not just mock call counts.

## 9. Later extraction into services

Vexa is already an isolated capture subsystem. Extract another module only when independent scaling,
failure isolation, data residency or team ownership provides measurable benefit. First candidates are
ASR/media processing and integrations. Preserve module ports and outbox contracts so extraction does
not rewrite customer/project logic. Separate databases and network hops are not a prerequisite for
adding founder features.
