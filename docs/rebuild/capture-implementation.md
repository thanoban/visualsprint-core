# Durable capture implementation and remaining qualification

2026-10-12. This is an implementation record, not a production-readiness certificate.

## Delivered path

Private Workspace meeting with original Meet/Zoom/Teams URL → owner-authorized Ingest
command → Account usage reservation → durable dispatch intent → Recall adapter → signed
raw-body callback → transactional transcript/inbox/outbox → permission-checked transcript.
API and reconciliation worker have separate compiled Node entrypoints and share only their
own Ingest database. No legacy browser bot or Google session JSON is used in this path.

Provider creation is attempted once per durable attempt. Timeout/crash uncertainty becomes
`dispatch_unknown`; lookup uses the attempt metadata. Even an empty lookup does not authorize
a second creation. Unknown attempts retain usage reservations for reconciliation. Explicit
capacity/validation rejection with no bot releases quota. A cancelled pre-dispatch command
does not create a bot.

Stop requests survive retries. A successful leave request is not proof of departure.
Provider departure plus terminal processing plus a 30-second quiet transcript drain is required
before finalization. Silence does not stop a quiet meeting. The provider and worker enforce a
four-hour maximum; the worker uses elapsed dispatch time, including admission and pauses.
All-bot departure uses a 90-second grace period at the provider. Live qualification must confirm
this behavior for each platform and host policy.

Coverage and transcript health are independent of capture state. No complete-coverage claim is
inferred merely from receiving text or a provider `done` event. Unknown coverage produces a
partial output; empty, unverified-silence transcripts fail. Late text is retained, invalidates
complete coverage, and emits a revision event. Machine revision 1 cannot replace human revision 2+.

## Contracts

- `POST /api/v3/workspaces/{workspaceId}/captures`: idempotency header,
  `{meetingId,expectedMeetingVersion,maxDurationSeconds?}`; durable accepted response `202`.
- `GET .../captures/{id}` and `GET .../meetings/{meetingId}/captures`.
- `POST .../captures/{id}/stop`: owner permission; independent of subsequent link edits.
- `GET .../captures/{id}/transcript?cursor={startMs}:{segmentId}`: 100-segment pages,
  total count, next cursor, current meeting read permission.
- Public gateway callback: `POST /webhooks/v3/cells/{configuredCellId}/recall`.
  Ingest verifies the exact forwarded bytes with workspace webhook secret(s), bounded timestamp,
  message ID and constant-time signatures. Invalid signatures never reach persistence.

Tenant tables use forced RLS under a non-owner role. A separate owning-service scheduler index
contains only workspace/request IDs and next-run time; it is intentionally enumerated by the
Ingest worker across its cell, not by users. Neither IDs nor signed provider metadata establish
user permission. Cross-service reads still use signed, authorized APIs, never SQL joins.

## Setup

Use `services/ingest/.env.example` as the variable checklist, not a populated secret file.
Trust Ingest's public signing key in Account and Workspace; trust gateway's key in Ingest.
Add the Ingest origin to gateway's configured cell routes. Run owning migrations before starting
`pnpm --filter @visualsprint/ingest start` and separately
`pnpm --filter @visualsprint/ingest worker`. The local database is loopback port 55436.

Configure Recall's workspace verification secret and dashboard bot-status events to the public
cell callback URL. Per-bot realtime transcription uses the same URL and explicit zero retention,
English low-latency transcription and null retained media. Never log passcodes, webhook secrets,
API tokens or transcript content. Provider configuration must be validated live before release.

## Tests and open work

Real local PostgreSQL tests cover isolation, idempotency, uncertain dispatch without duplicate
creation, signed callbacks, duplicate/digest conflict, joining-stop races, confirmed departure,
draining, quota cleanup, human revision protection, pagination and duration ceiling. Composition
tests run gateway, Account, Workspace, Authz/OpenFGA and Ingest with separate databases.
Hosted identity and the external capture provider are controlled fixtures in these tests.

Open: Azure Service Bus outbox publishing/telemetry,
operator resolution of indefinitely unknown dispatch, permission/deletion-triggered cancellation,
calendar operation principals, full transcript paging UI, health/gap instrumentation, real provider
admission/end/full-duration tests and performance qualification. The current worker uses a durable
owning-database routing index; it is not yet the final Azure event transport. Existing populated
Ingest databases require an explicitly scoped work-index backfill, not a bypass-RLS migration.
F3 calendars, F4 intelligence/chat, F5 integrations/data rights and F6 staging remain unfinished.

Interrupted Account reservation replies now recover through a signed, owner-scoped cleanup-only
lookup. Workers recheck the stored meeting version before pending dispatch; changed/revoked context
fails closed and held quota is released. Cancellation and late reservation acknowledgements enqueue
cleanup transactionally, including after scheduler removal. Logout does not prevent quota cleanup.
