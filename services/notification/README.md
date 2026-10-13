# Notification service — 2026-10-13

Notification owns its separate PostgreSQL database, API, delivery worker and event process.
This is a controlled-provider local implementation, not evidence of live email or Azure delivery.

## Implemented

- Owner-specific workspace preferences. Both channels default off; email additionally requires explicit
  consent. The destination comes from Account's verified profile, never client input or a calendar grant.
- Generic metadata-only in-app/email notifications for authorized summary/action events. Capture status
  updates are in-app only, avoiding an email for every capture transition.
- Inbox effects and dedupe commit atomically before message acknowledgement. Duplicate IDs with changed
  envelopes conflict. Signed HTTP ingress binds issuer/type/workspace/actor; broker subscriptions use
  fixed authoritative source topics and require least-privilege publisher/subscriber identities.
- UTC-hour individual email schedules, versioned settings and stable idempotency keys. These are not
  combined daily digests. Future work does not send early. Disabled preferences cancel queued work.
- Transactional external-send intent, bounded leases and fencing. Unknown send/crash results perform
  lookup only; another send requires authoritative `not_sent`. A provider's incomplete search is not
  sufficient absence evidence. Delivery IDs are provider idempotency/correlation keys.
- Current membership and source ACL/deletion barriers before delivery and every in-app read. Ordinary
  logout does not erase consented background preference, but revoked membership/source access holds
  delivery and hides already-delivered in-app references. Dependency outages fail closed.
- Email text contains no meeting title, customer/project, transcript, task description, recording,
  provider join URL or passcode. It links only to the configured first-party workspace origin.
- Per-attempt safe status/reference records; no destination address or email body persists in this DB.
- Metadata-only outbox events, leased delivery and same-event-ID retry after lost broker acknowledgement.
- Workspace-only deletion participant with immutable target tombstones, reordered-event fencing and
  purge of deliveries/attempts. Only uncertain-send metadata references remain for separate cleanup;
  an already-sent generic email cannot be recalled or truthfully reported as erased from a mailbox.
- A dedicated web preferences/update-center component with explicit consent, UTC schedule labels,
  source-authorized first-party meeting links and versioned read acknowledgement.

## Public API

Base `/api/v3/workspaces/{workspaceId}`; gateway-delegated normal user actors only.

- `GET /notification-preferences`
- `POST /notification-preferences`, `Idempotency-Key`, body
  `{expectedVersion,inApp,email,deliveryHourUtc:null|0..23,emailConsent}`
- `GET /notifications?after={uuid}` returns bounded authorized in-app references and `nextCursor`.
- `POST /notifications/{id}/read`, `Idempotency-Key`, `{expectedVersion}`. Reading is naturally
  idempotent; after the first successful read a matching old retry does not repeat a side effect.

## Internal authority and messaging

Notification signs as `notification` to Account/Workspace using a configured pinned service key.
Public commands verify the normal delegated session with Account membership.
Background checks use only the narrowly allowed `notification:{deliveryId}` subject label:

- Account `POST /internal/workspaces/{ws}/notifications/membership`, `{userId}`;
  current self membership only, response `{active:true,verifiedEmail:string|null}`.
- Workspace `GET /internal/workspaces/{ws}/meetings/{id}/notification-context`;
  authoritative current member/local ACL/OpenFGA/deletion checks, references only.

These capabilities never grant broader content reading, membership edits, external approvals or
calendar access. API callers cannot replace authority with client workspace IDs or event references.

Signed event HTTP: `POST /internal/workspaces/{ws}/events`. Only Intelligence summary-ready,
Workflow action-completed and Ingest capture-state event issuers are accepted for their owned types.
Native `events.mjs` consumes those fixed `vs-*` source topics (subscription `notification`) and publishes
`notification.delivery.changed.v1` on `vs-notification`; all payloads satisfy the metadata-only envelope.

Deletion: pinned Workspace calls `POST /internal/workspaces/{ws}/deletions/{id}` with
`{meetingId,sourceVersion}`. After owned purge commit:
`{deletionId,meetingId,participant:"notification",state:"complete"}`.
Restore must replay tombstones before consuming events, serving reads or running delivery workers.

## Configuration and release gates

Local PG55441/API4109; `local-init.sql` contains local-only role credentials. Apply owned migrations
with the migration role, never the API runtime. See `.env.example` for signed origins/keys/config.
Production requires private TLS origins, Key Vault credentials and managed identity for Service Bus.

The optional native Azure Communication Email adapter is wired with managed identity. It remains
disabled without the endpoint/sender pair. Account's optional WorkOS server profile adapter and owned
`0004` projection are wired; an absent server key returns `verifiedEmail:null`. Missing configuration
or verification holds email work with safe codes; a saved preference does **not** prove delivery.
Credential preflight precedes durable send intent and is followed by fresh membership/source/recipient
checks. The intent transaction serializes against local preference changes and checks schedule/consent.
Opt-out committed before intent prevents a new send; already-committed uncertain intent remains
lookup-only. No real provider call or paid provisioning was performed by this qualification slice.

The Azure adapter uses fixed provider operation IDs and lookup-only reconciliation after uncertain
POST results; a missing operation is not proof of no send. `provider_sent` records send-operation
confirmation, not actual mailbox delivery. See [EMAIL_SETUP.md](EMAIL_SETUP.md) and
[EMAIL_ACTIVATION.md](EMAIL_ACTIVATION.md) for configuration, costs and release gates. Live WorkOS
verification, deployment domain/RBAC/quota, mailbox delivery/bounces and Service Bus settlement remain
release gates.
The in-app pipeline is locally qualified with real PostgreSQL and controlled current authorities.

Local verification: service/native API-worker-events build and typecheck, service boundary checks,
focused schedule/origin/provider tests and real PostgreSQL/HTTP tests. Tests cover
concurrent inbox dedupe, changed event identities, schedules, consent/version/key conflicts, held source
access, normal logout, safe generic email fixtures, unknown-send lookup-only retries, stale worker
fencing, owner/tenant/caller isolation, deletion and outbox acknowledgement loss. The dedicated browser
fixture passed in the preceding coordinated full browser suite; local fixture sends are not live mail.
