# Calendar → private meeting → capture bridge

Date: 2026-10-12. This delivers explicit imports, not unattended scheduled capture.

## Delivered flow

1. Complete a durable calendar snapshot in Integration.
2. In Calendar connections, load saved events and choose **Import private meeting**.
3. The browser sends only occurrence ID and expected source version, with an idempotency key.
4. Integration rechecks current membership, connection ownership, the selected calendar and
   latest complete snapshot. It loads the authoritative title, times, state and join URL.
5. Signed Integration delegation posts a strict contract to Workspace's separate internal
   calendar endpoint. Gateway and Ingest signing keys do not authorize that endpoint.
6. Workspace transactionally creates or updates the owner-private meeting and its source
   mapping, emitting a metadata-only meeting event. Repeating the import returns the same ID.
7. Open the imported meeting. The existing capture panel uses the same Ingest authorization,
   usage reservation, intent, dispatch, transcript and stop pipeline as pasted links.

Import never automatically starts a bot, assigns a project/customer, or shares access.
The owner must still confirm context and separately grant readers. Calendar credentials and
session tokens never cross into the browser or Workspace persistence.

## Correctness and boundaries

Workspace owns its calendar meeting mapping, migrations and forced-RLS table. Integration
owns normalized source occurrences. No cross-database SQL, FK or shared persistence model
was added. Internal HTTP carries both verified service identity and delegated user authority.
Operation principals are explicitly rejected until background orchestration is delivered.

Source versions suppress old updates. Conflicting equal revisions fail. Import idempotency
keys reject changed payloads, while Workspace's source-based command makes uncertain HTTP
responses safe to retry. Replays return the currently authorized meeting, not stale cached
content. Post-call source/connection checks reject changed or disconnected results.

Calendar changes preserve user notes and owner-corrected titles. Meeting rows are locked
while projecting changes so concurrent user corrections are not overwritten. Existing
sharing and confirmed assignments remain unchanged. Blocked meetings cannot be recreated
through an import. A cancelled/declined/all-day source cannot create a new ordinary meeting;
an explicit cancellation update preserves existing history but blocks new capture requests.
Already-running bot cancellation still requires the unfinished scheduled orchestration path.

## Setup and verification

Set Integration `WORKSPACE_INTERNAL_URL` to the trusted Workspace service origin. Configure
Workspace `INTEGRATION_PUBLIC_JWKS` with the Integration signing key's public JWK set and
run Workspace's new migration with its migration role. Do not put private keys in web envs.
Missing configuration fails closed; no fallback direct database access exists.

Tests use real Account/Integration/Workspace/Ingest HTTP and service databases with controlled
calendar/identity/capture providers. They cover private stable IDs, repeated imports, notes/
title preservation, cancellation barriers, source payload injection and capture admission.
Browser tests exercise actual application controls and signed service APIs. Provider meeting
admission, live OAuth, long-running capture and production latency remain release gates.

## Next / not complete

Background grant activation, periodic/incremental synchronization, provider notifications,
Integration event delivery/consumers, scheduled dispatch, reschedule/cancellation cleanup,
and ad-hoc/calendar convergence still need complete durable orchestration. Intelligence,
saved chats, approved connectors, reporting/deletion and Azure release gates also remain.
No paid cloud resource or live meeting bot was used by this implementation.
