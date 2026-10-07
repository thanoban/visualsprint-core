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
