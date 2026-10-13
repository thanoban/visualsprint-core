# Implementation status

Date: 2026-10-12. Branch: codex/zedex-web-rebuild.

## Implemented in the first foundation slice

- Complete linked architecture/ownership, contract, competitor, delivery and operations package.
- Isolated pnpm/Turborepo TypeScript workspace; legacy application tooling is separate.
- Zod event, assignment, transcript and operation contracts.
- Capture lifecycle transitions, finalization/coverage rules and 90-second empty-room policy.
- Supported Meet/Zoom/Teams link validation with passcode preservation.
- Recall create adapter with explicit text-only/ZDR English configuration, bounded transport,
  no redirect following, capacity classification and ambiguous-create handling without blind retry.
- Service import-boundary check and separate CI workflow.

Local verification passed: frozen-lockfile installation, service import-boundary checks,
TypeScript checks, 15 contract/domain/transport-fixture tests and compilation of both packages.
Rebuild document links and Git whitespace checks passed. These are local Windows results;
the new GitHub Actions workflow independently checks Linux after publication.
Dependency lifecycle scripts remain disabled for esbuild; the platform binary is supplied
through its pinned optional dependency.

Architecture checkpoint: `cd93c4e`, pushed to `origin/codex/zedex-web-rebuild`.
The code foundation is published as a separate checkpoint following those checks.

## Not yet implemented / not represented as ready

Current remaining work: live WorkOS login/refresh and Azure broker qualification, calendar
occurrence sync and automatic capture orchestration, intelligence UI/pipeline, saved chat,
approved connectors, notifications, exports/deletion and Azure Bicep. Implemented capture
and calendar connection code is documented in the later checkpoints below; live joining
on Meet/Zoom/Teams still requires gated provider tests.
Live and visual Flows remain later scope.

No live Recall call, meeting join, model call, Azure deployment or data migration
has been performed by this foundation slice. Unit transport fixtures are not live provider proof.
Docker is available and the Workspace integration suite uses PostgreSQL 17.6.

## Workspace persistence/API slice (F1 in progress)

- Independently runnable Fastify Workspace service with service-owned Drizzle schema/migration.
- Customers/projects, private meetings/notes, explicit assignment, sharing/revocation and versioned edits.
- Forced tenant RLS, distinct runtime/migration roles and startup rejection of unsafe runtime roles.
- Commands and events commit atomically; concurrent idempotency keys are serialized and payload conflicts fail.
- PostgreSQL outbox leases/fencing and transactional consumer inbox withstand duplicate delivery/crashes.
- Signed service delegation binds caller key, audience, tenant and actor; WorkOS JWT verification utility.
- Real database/HTTP integration tests and CI dependency setup; controlled membership authority in tests.

Verification: 18 fast tests, all four packages typechecked/compiled, and eight real
PostgreSQL/HTTP integration tests passed locally on 2026-10-12. Account is a controlled
membership provider in this suite; actual inter-service Account wiring is the next slice.

## Account and gateway slice (F1 in progress)

- Separate physical local Account PostgreSQL server, private logical database and migration/runtime roles.
- Verified WorkOS identity mapping, idempotent workspace creation, server-controlled cell assignment,
  versioned membership changes, immediate membership barriers and local session revocation.
- Account endpoints require both a gateway proof and verified user token; internal requests verify
  caller-specific signing keys plus the delegated actor/session/workspace.
- Stateless gateway resolves identities/membership/cell through Account and routes to configured origins.
- Workspace reads current Account membership over signed HTTP; it fails closed on authority outages.
- Composition tests exercise the real gateway and services over HTTP with both real databases.

WorkOS signatures use a controlled RSA/JWKS provider in tests. Live WorkOS login and refresh remain
external qualification. F1 remains open until OpenFGA, web UI and broker wiring pass together.
Verification: 20 fast tests, six compiled/typechecked packages, two Account database tests,
eight Workspace database/HTTP tests and one multi-service HTTP composition test passed.
Native Node runtime bundles now boot Account, Workspace and gateway successfully in a
separate process test. Code formatting is standardized across the rebuilt TypeScript tree.
Next slice: React private workspace UI; then F2
durable signed capture ingress and UI. Do not expose the create adapter directly as a public endpoint.

## OpenFGA authorization slice (F1 in progress)

- Independent Authz API and pinned OpenFGA 1.22.0 PostgreSQL runtime/database/migration roles.
- Operator bootstrap writes the versioned model; runtime checks pin both store and model IDs.
- Workspace uses signed Authz delegation after current Account membership and local ACL checks.
- Current owner/reader/deletion facts are an upper bound; stale engine relationships cannot expand access.
- Meeting lists batch remote policy requests; checks run with bounded parallelism.
- No project/customer association grants permissions. Model/runtime outages fail closed.
- Integration tests use real OpenFGA and PostgreSQL; HTTP composition includes Authz.

Verification: 22 fast tests, seven service/package builds and 13 database/runtime/composition
tests passed locally. Production private TLS, WorkOS hosted login, Azure broker wiring and
live meeting capture remain unqualified. The product is not yet a completed release.

## Web workspace slice (F1 in progress)

- React/Vite and TanStack Router web app with WorkOS AuthKit session/refresh integration.
- Customer/project creation, workspace switching, private meeting creation, project-filtered
  lists, notes editing, owner-confirmed assignments and separate explicit sharing/revocation.
- Browser API credentials stay on same-origin `/api/v3`; redirects are rejected. No secret browser envs.
- Request cancellation/scope reset removes stale data when changing workspace/project/access.
- Retry keys survive uncertain command responses; version conflicts do not silently overwrite edits.
- Browser tests cover context separation, assignment/sharing, script-like text and outage behavior.
- A real browser saves/reloads notes through gateway, Account, Workspace, Authz and PostgreSQL.
  Only hosted identity is controlled; service responses and persistence are not mocked.

Verification: 24 fast tests, eight checked/built packages, three browser fixture tests and 13
database/runtime/composition tests. Browser identity fixtures have their own test root, never
the production entry point. Actual hosted WorkOS consent/session refresh still requires configured
identity settings. F1 still needs Azure messaging/telemetry and deployment qualification.
Next: complete durable capture endpoints/worker/webhooks, then calendar and intelligence slices.

## Capture usage admission slice (F2 prerequisite)

- Account-owned entitlements, capture reservations and append-only measured usage ledger.
- Initial server-owned limits: five active captures and 360,000 seconds per UTC start month.
- Workspace-wide transaction locks enforce concurrent admission; retries reserve/charge once.
- A provider-ambiguous attempt holds capacity until reconciled. Age alone never releases a reservation.
- Measured overruns remain recorded; exhausted budget blocks future admission instead of hiding costs.
- Signed Ingest alone can reserve/settle/release. Cleanup can finish after logout or membership loss.
- Service capabilities prevent a Workspace signing key from changing Account memberships.
- Runtime cannot modify entitlement limits or update/delete ledger rows; forced RLS protects all tables.

Verification: 25 fast tests and 16 integration/runtime/composition tests. Capture dispatch is not
yet wired to this ledger; no paid capture call has been made. Reservation maximum is four hours;
the provider/worker must enforce that duration before this slice can qualify F2.

## Durable capture implementation (F2 in progress)

Ingest now owns PostgreSQL migrations/RLS, durable capture intents, per-attempt routing,
signed raw-body ingress, revision-aware transcript storage, usage admission/cleanup and a
separate compiled reconciliation worker. Gateway forwards provider callback bytes unchanged.
The web meeting panel starts capture, displays state/health/coverage and requests a durable stop.
Unknown provider creation never causes a blind second bot; stop acceptance is not departure.
Late transcript drain and explicit partial coverage prevent false complete reports.

Implementation and open gates: [capture record](capture-implementation.md). Local verification
includes real multi-service authorized capture and signed transcript persistence with a controlled
provider. No paid/live Recall call has been made. Calendar automation, intelligence, follow-through,
Azure messaging/deployment and live Meet/Zoom/Teams qualification remain incomplete.

Verified locally: 33 fast tests, eight package/service builds, 23 database/runtime/composition
tests and three browser fixture tests passed. Dependency audit reports no known production
vulnerabilities. These results do not establish live provider admission or production capacity.

### Reservation recovery hardening

Pending quota intent is reconciled automatically through Account's signed Ingest-only lookup,
including lost responses and cancellation races. Lookup exposes only owned reservation state and
maximum seconds, not meeting content. Late acknowledgements re-enqueue cleanup; logout cannot strand
usage. Lease bookkeeping no longer advances user-facing aggregate versions.
Verification: 33 fast tests, eight builds and 26 database/runtime/composition tests passed.

## Event delivery implementation (F1 wiring in progress)

Shared technical Azure SDK encoding/settlement, independent Workspace/Ingest outbox publishers,
owning routing indexes and compiled event-worker entrypoints are implemented. Managed identity
is the only production credential path. Unknown broker sends retry the same immutable event ID;
consumer acknowledgement follows the owning inbox/effect commit. No content enters bus envelopes.

Verification: 36 fast tests, nine package/service builds, 27 database/runtime/composition tests,
four browser fixture tests and a clean production dependency audit. Azure transport is controlled
in local tests; no live namespace has been contacted. See [event delivery record](messaging-implementation.md).
F3–F6 and live provider/deployment qualification remain unfinished; this is not the final product.

## Calendar operation principals (F3 prerequisite)

Account owns consented calendar-capture grants; the gateway exposes owner-scoped grant lifecycle
commands. Short signed operation delegation is distinct from WorkOS sessions. Logout does not
erase approved background authority, but current grant/member/workspace revocation blocks new
work. Public user APIs reject operation principals; grants cannot edit memberships or approve
external writes. Ingest preserves the principal during durable recovery. See
[operation-principal record](automation-principals.md). Calendar sync and automatic capture are
still not implemented end to end.
Verification: 37 fast tests, nine builds, 28 database/runtime/composition tests and four browser
fixture tests passed. A test assertion was corrected to respect the scheduler's bounded batch
rather than assuming every accumulated fixture workspace appears in its first page.

## Calendar OAuth and connection controls (F3 in progress)

Integration now owns an independent database, forced RLS, migrations, encrypted OAuth/token
storage, Google/Microsoft read-only adapters, connection APIs and recovery worker. Web
controls connect, validate, select and disconnect through the gateway. PKCE state binds the
original owner/session/workspace; only backend processes redeem or refresh credentials.
Unknown exchange results are not blindly retried. Refresh rotation persists before provider
reads; disconnect clears credentials and fences late results. Owner connections remain
private from other workspace members. See [implementation/setup](calendar-connections.md).

Automatic capture is deliberately reported unavailable until occurrence synchronization and
scheduled dispatch are wired. Real vendor consent, refresh policies and Azure deployment
remain external gates; this is not F3 completion or a final production release.

Verification: 46 fast tests, ten package/service builds, 33 database/runtime/composition
tests and five browser fixture tests passed locally. Production dependency audit found no
known vulnerabilities. The composition browser also saved/reloaded calendar selection and
disconnected through actual signed service APIs. Docker dependency restart was needed;
the full suite passed after restoration without deleting test data.

### Calendar occurrence read/normalization checkpoint

Google expanded instances and Microsoft calendarView are available through owner-private,
bounded, paginated APIs and a read-only web preview. Tests cover original recurring identity,
rescheduling, distinct events reusing a call link, timezone normalization, cancelled/declined/
all-day events, passcode preservation and unsafe paging links. Verification: 52 fast tests,
ten builds, 33 database/runtime/composition tests and five browser fixtures passed locally.
The actual service composition and browser call the new read endpoint with controlled vendor
responses. Calendar occurrence persistence, incremental synchronization, capture policy and
automatic dispatch are **not** complete; live vendor qualification remains outstanding.

### Durable calendar snapshots (F3 in progress)

Integration now persists explicit sync jobs, page cursors/staging and versioned normalized
occurrences. Its worker resumes after interruptions, publishes only complete snapshots with
atomic metadata outbox changes, and fences logout/disconnect/configuration races. Database
sequence ordering fixes equal-timestamp snapshots. Batched page and outbox writes avoid
per-event database round trips. Public endpoints and web controls show queued/completed
states. See [implementation and limitations](calendar-sync.md).

This delivers durable requested snapshots, not complete unattended calendar automation.
Incremental cursors, notifications/reconciliation, background grant activation and cross-service
meeting/capture orchestration remain next. Intelligence/chat, approvals/connectors, exports/
deletion and live production qualification are still required before a final release.

Local verification: 52 fast tests, 36 database/runtime/composition tests, five browser
fixtures and ten builds passed. Production dependency audit found no known vulnerabilities.
Tests verify exactly-once occurrence effects through the outbox, metadata-only events and
complete-snapshot visibility across provider outages. These are controlled-provider local
results, not live calendar or automatic meeting-join qualification.

### Calendar → private meeting → capture bridge (F3 in progress)

Saved occurrences can now be explicitly imported through Integration's signed Workspace
adapter and dedicated internal endpoint. Workspace owns stable private source mappings;
retries preserve IDs, human notes/title corrections and separate assignment/sharing. Source
revision conflicts and cancelled capture requests are rejected. Browser controls open the
imported meeting's existing capture panel. The real service composition also verifies quota
admission for an imported meeting with a controlled provider.

See [flow and setup](calendar-meetings.md). This is explicit import, not automatic scheduled
capture. The unattended orchestration and remaining F4–F6 features are not completed.

Verification: 53 fast tests, 37 database/runtime/composition tests, five browser fixtures
and ten builds passed locally; production dependency audit found no known vulnerabilities.
The composition verifies imported-meeting Ingest quota admission and browser import through
real signed services/databases. Providers remain controlled; no paid cloud resource or live
meeting was used. Prior checkpoint `94c334a` also passed GitHub Actions independently.

### Background calendar synchronization and scoped operation authority

Owner consent now activates a connection-bound background policy. Integration periodically
creates durable snapshot jobs carrying the operation grant; normal logout does not break
approved work. Revocation/member loss disables policy and queues grant cleanup. Workspace
verifies current Account grant context before calendar projections/capture access, preventing
an operation grant from reading unrelated meetings. Public user APIs still reject these
principals. Browser controls distinguish policy permission from unimplemented bot dispatch.
See [authority and limits](background-calendar.md).

Verification: 53 fast tests, 39 database/runtime/composition tests, five browser fixtures
and ten builds. The composition uses genuine signed Account grant validation after logout
and real PostgreSQL/OpenFGA; provider responses remain controlled. A browser lease race
was fixed by disabling read/edit controls until calendar loading finishes. Scheduled bot
dispatch and the remaining F3–F6 deliverables are still unfinished.

### Deferred capture dispatch (F3 scheduling prerequisite)

Ingest persists an optional join window without holding future live capacity. Due work
reconciles usage and current authority before dispatch. Future cancellation wakes cleanup
immediately, and routing updates are transactionally fenced against stale reschedules.
Revocation after admission blocks first provider creation and releases capacity. A separate
signed Integration endpoint requires a scoped operation principal; public routes reject it.
The meeting UI schedules explicit captures and distinguishes queued time from a confirmed join.
See [behavior and remaining wiring](scheduled-capture.md).

Local verification: 53 fast tests, 42 database/runtime/composition tests, six browser tests
and ten builds. Prior background-sync checkpoint `dbe8db5` passed GitHub Actions. Calendar
occurrence-to-capture orchestration, remaining F4–F6 features and live qualification are not
finished; no paid/live capture or Azure resource was used.
