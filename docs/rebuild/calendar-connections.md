# Calendar connections implementation

Date: 2026-10-12. This is an F3 prerequisite, not completed automatic capture.

## Delivered

Integration is an independent Fastify service with its own PostgreSQL database,
migration/runtime roles, forced tenant RLS and worker. Google Calendar and Microsoft
Outlook use read-only confidential-client OAuth with PKCE and offline access.
The browser never receives access/refresh tokens or client secrets.

The owner starts an idempotent connection, consents at the vendor, returns to
`/oauth/calendar`, and chooses a calendar. The callback is bound to the original
workspace, owner, WorkOS session and a ten-minute random state. Only routing metadata
is temporarily stored in sessionStorage. The callback removes the authorization code
from the address bar before initializing AuthKit; codes are not persistent browser data.

Tokens and OAuth verifiers use AES-256-GCM with authenticated workspace/connection/purpose
context. Key IDs support the current key and up to two previous keys. Losing a required
key fails closed; do not remove old keys until their rows are re-encrypted or disconnected.

Token refresh is leased, persists rotated credentials before subsequent provider calls,
and does not create false user-edit version conflicts. Selection and disconnect use
idempotency keys and optimistic versions. Disconnect immediately clears credentials and
prevents in-flight results from restoring access. Any recorded background grant cleanup
is durable and limited to that owner/connection, even after logout or revocation.

Code redemption is claimed before external I/O. A timeout or worker crash cannot cause
blind reuse of a possibly consumed code. Successful exchange persists credentials before
calendar validation, so a transient calendar API outage does not force another consent.
Google's `primary` alias resolves to a real calendar ID. Graph requests use immutable IDs.
Paged Graph URLs are restricted to the fixed Microsoft origin/path before credentials
are sent. Vendor responses, timeouts and stream sizes are bounded.

Owner connections are private even from other active workspace members. Metadata-only
outbox events contain references, not tokens, calendar names or meeting content. OAuth
configuration errors and calendar reauthorization are distinct from VisualSprint logout.

## Setup, without provisioning infrastructure

1. Start the local Compose dependencies; Integration PostgreSQL is loopback port 55437.
2. Configure `services/integration/.env.example` through process variables or approved
   Key Vault references, not committed files. Omit both client variables to disable a vendor.
3. Generate a dedicated Integration EdDSA signing key, configure Account's Integration
   public key, and configure Integration's trusted gateway key. Other service keys do not
   authorize these Account operation/cleanup endpoints.
4. Supply `TOKEN_KEY_ID` and `TOKEN_KEYS` (a JSON key-ID/base64-32-byte-key dictionary).
   These are backend secrets, never `VITE_*` settings.
5. Register a Google **Web application** OAuth client; enable Calendar API and consent for
   `https://www.googleapis.com/auth/calendar.readonly`. Add the exact callback URI and
   permitted test users, then complete the vendor's production/verification requirements.
6. Register Microsoft as a **Web/confidential client**, not a SPA token-redemption client.
   Configure the supported account audience, delegated `Calendars.Read`, offline access,
   client secret and exact redirect URI. Organization consent policies still apply.
7. Set `CALENDAR_REDIRECT_URI=https://your-owned-host/oauth/calendar`. Serve the web app's
   SPA fallback there; route `/api/v3` to the gateway. WorkOS identity configuration is
   separate. Development permits localhost HTTP; production requires HTTPS.
8. Add Integration's operator-controlled origin to the matching gateway `CELL_ROUTES`,
   migrate with its migration role, and start its API and independent worker after Account.
9. Open the workspace's Calendar connections panel, connect, verify the selected calendar,
   test refresh and disconnect. Perform live consent/refresh tests before release.

[Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
requires offline access for refresh tokens. Google external consent apps in Testing can
issue calendar refresh tokens expiring after seven days; token revocation/expiration must
always remain actionable. [Google token lifecycle](https://developers.google.com/identity/protocols/oauth2).
Microsoft's SPA redirect token lifetime differs from confidential web flows; the backend
redeems codes here. [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
No design can guarantee that provider consent never needs renewal.

## Verification and remaining work

Local tests cover encrypted persistence, state/session/owner/tenant rejection, duplicate
commands, uncertain exchanges, expiry, refresh rotation, provider errors, safe paging and
credential removal. Browser tests exercise actual production controls; the composition
test runs gateway, Account, Workspace, Ingest, Integration, Authz and real databases with
controlled identity and calendar responses. Native compiled Integration also boots in its
own process. These are not live Google/Microsoft proof.

Next: durable occurrence synchronization and reconciliation, recurrence/rescheduling,
calendar notifications, explicit capture-policy activation, private meeting upserts and
scheduled Ingest dispatch/stop. The UI reports `automaticCaptureReady: false` until those
flows are implemented and verified. Calendar read consent is not capture permission.

## Read-only occurrence preview checkpoint

Owner-scoped `GET /:connectionId/occurrences` now reads a bounded 14-day window and returns
normalized occurrence records, window and next cursor. Subsequent pages preserve the same
window. The UI previews these events without launching capture or creating/sharing meetings.
Current membership and credential leases protect reads; disconnect blocks subsequent reads.

Google expands instances using provider recurrence/timezone rules. A recurring occurrence's
identity uses series ID and original start, so rescheduling does not identify it by its new
time or reused call URL. Graph requests immutable IDs and UTC timestamps. Unrecognized
timezone-less times fail explicitly rather than being interpreted in server local time.
All-day, cancelled and declined records remain distinct; ambiguous/unsupported call links
return null. Link parsing never executes HTML and preserves Zoom passcodes.

Graph page URLs must remain on the selected calendar's fixed origin/path. Responses and
pages are bounded, and malformed vendor data is an upstream error. Google window requests
do not use incompatible `syncToken` parameters. See
[Google event list semantics](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[recurring instance identity](https://developers.google.com/workspace/calendar/api/guides/recurringevents)
and [Graph calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0).

This is a provider read/normalization slice, **not persisted synchronization**. Incremental
cursors, transactional occurrence/outbox storage, notification reconciliation and calendar
to Workspace/Ingest orchestration remain next. Missing records in a preview are not proof
of cancellation. No bot is automatically started, and no provider live call was performed.
