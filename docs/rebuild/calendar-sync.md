# Durable calendar snapshot implementation

Date: 2026-10-12. F3 remains in progress; automatic capture is not enabled.

## Implemented vertical slice

The owner explicitly requests `POST /connections/calendar/{id}/sync` with an idempotency
key. Integration commits a job containing the selected calendar/version, fixed 14-day
window and requesting principal. The independently compiled Integration worker processes
one provider page at a time using the existing encrypted-token lease. It checks current
Account authority before reading and again before committing results.

Pages and continuation cursors commit in the same tenant transaction. Page counts fence
stale results; connection leases/version checks fence disconnects and configuration changes.
After a crash, the worker resumes the persisted cursor, not the first page. Reordered or
duplicate workers cannot silently replace a newer page. Repeated cursors and inconsistent
duplicate source records fail the job instead of producing unreliable data.

Only the final page promotes the complete staged snapshot into versioned occurrences and
creates reference-only `calendar.occurrence.changed.v1` outbox records atomically. Normalized
source identities preserve occurrence IDs across reschedules and reused URLs. Unchanged
content does not advance occurrence versions. Database-generated job ordering avoids
equal-timestamp ordering bugs. Page staging and final promotion use bounded bulk writes.

`GET /{id}/sync` exposes job state/page count/error, not tokens, session IDs or provider
cursors. `GET /{id}/stored-occurrences?after={uuid}` pages the last complete snapshot, 100
items at a time. A failed or incomplete replacement leaves that complete view intact.
Missing events leave the new snapshot but are **not** marked cancelled; explicit vendor
cancellation is separate. Future cancellation orchestration needs authoritative lookups.

Tenant RLS, private owner access and distinct migration/runtime roles apply to all four
new tables. Jobs cannot create cross-service meetings, assign projects, share data or start
a bot. The UI requests synchronization and refreshes status separately from preview.

## Limits and operational behavior

- Explicit, user-requested snapshots only in this slice, not unattended periodic sync.
- At most 100 events/page and 20 pages/job. Overflow fails visibly without truncating the
  published snapshot. The window is server-chosen and does not drift between pages.
- Transient failures preserve progress and use the worker's retry delay. Logout or membership
  loss blocks pending jobs. Approved session-independent background authority is the next
  orchestration slice; no user session is fabricated or reused as a hidden permanent login.
- Disconnect clears credentials immediately and supersedes in-flight synchronization.
- Worker routing contains only workspace/connection IDs. Staged content is removed on
  promotion or terminal failure. Provider bodies, passcodes and tokens are not logged.
- Changes are durably queued in Integration's outbox. Its broker publisher/consumers still
  need wiring before downstream services can consume them in production.

## Verification and unfinished scope

Real PostgreSQL tests cover page interruption/resume, idempotent requests, last-complete
visibility, cursor loops, revocation, disconnect during fetch and tenant isolation. Full
composition exercises the actual signed gateway/Account/Integration HTTP path and worker
use case with controlled vendor responses. Browser controls distinguish queued from complete.
No live Google/Microsoft API, paid model call, Recall bot or Azure deployment was used.

Next: incremental provider cursors/notifications, periodic reconciliation under explicit
operation grants, Integration event delivery, Workspace private calendar meeting upserts,
scheduled Ingest requests and cancellation/stop handling. Intelligence/chat, exact-payload
approved actions, reporting/deletion workers and release qualification remain unfinished.
