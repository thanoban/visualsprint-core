# Intelligence metadata outbox publisher

`pnpm --filter @visualsprint/intelligence events` starts the independent native
publisher after the owning ordinary migrations. Configure `INTELLIGENCE_DATABASE_URL`,
`SERVICE_BUS_NAMESPACE`, and the managed identity client ID in production. The identity
needs Data Sender on **vs-intelligence**, not namespace-wide receive permissions.
No model calls or capture processing are performed by this process.

Migration 0006 backfills existing unpublished events and installs a transactional
reference-only scheduler trigger. Content stays in the forced-RLS outbox; routing
references are not permission. Pending references disappear on acknowledgement or
owning deletion. Batches are bounded, rows leased with SKIP LOCKED, and each lease
is rechecked before dispatch. Unknown broker results keep the event unpublished
until the lease expires; retries reuse its event ID. Consumers must use their inbox
and reauthorize source content. This is at-least-once delivery, not exactly-once I/O.

Logs emit error codes, not payloads, workspace IDs, credentials or transcript text.
Local PostgreSQL tests use an in-memory broker boundary; real Service Bus identity,
network reachability, delivery and notification behavior remain staging gates.
