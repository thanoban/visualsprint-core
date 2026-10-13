# Calendar change tracking and push — 2026-10-14

This is an Integration-owned implementation with local PostgreSQL and controlled-provider tests.
No real Google/Microsoft subscription, calendar write, cloud resource or additional consent scope
was created. Existing OAuth callback paths and owner-approved background grants are unchanged.

## Durable read flow

Google change rounds use `events.list` with fixed IDs-only fields, `singleEvents:false`, deleted
entries enabled and private sync/page tokens. They never combine a sync token with time bounds.
Changed IDs are hints: the existing bounded, expanded 14-day snapshot determines actual recurrence,
cancellation, decline and meeting-link data. A token advances only in the transaction publishing the
complete snapshot. Unchanged rounds carry the prior complete generation forward without fetching
all occurrence details. This avoids implementing an unreliable recurrence merge.
[Google synchronization](https://developers.google.com/workspace/calendar/api/guides/sync),
[events list restrictions](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

Microsoft tracking uses the stable v1.0 primary `calendarView/delta` contract, immutable IDs and a
fixed date range. Continuation/delta URLs are pinned to the exact Graph origin/path and are never
rewritten or followed to a different calendar. Unsupported secondary calendars keep complete
snapshot polling; beta APIs and broader permissions are not silently substituted. Delta reads do
not request unsupported `$select`. Both feeds are capped at 20 pages of 100 identifiers; overflow,
cursor loops, unsupported configuration or HTTP 410 fall back to a complete bounded snapshot.
[Microsoft delta contract](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0),
[range/continuation rules](https://learn.microsoft.com/en-us/graph/delta-query-events).

Background reconciliation remains every five minutes. A full snapshot at least hourly rolls the
14-day window. All effects remain fenced by connection version, token lease, current operation grant
and membership. Partial pages never replace the previous complete view. Missing, previously in-window
events become explicit cancellation records so existing durable capture attempts stop. A known lost
calendar permission fails closed and disables automatic work; transient outages preserve recovery.

Deletion suppression applies before staging, initial occurrence INSERT and updates. Late provider
responses cannot restore a deleted meeting's stored content. Generated events carry only references.
Checkpoint/page tokens remain private RLS-protected service metadata and never enter public responses,
logs, broker events, prompts or user-controlled redirects.

## Optional push flow

Push is a wake-up hint, not calendar truth, source-read authority, a new capture grant or a realtime
guarantee. An absent `CALENDAR_PUSH_CALLBACK_BASE` disables subscription creation and retains polling.
After explicit operator configuration, the existing background grant/refresh-token lease is checked
before a durable provider intent. Notifications cannot activate a disabled connection or bypass owner
capture policy. Provider receivers persist an authorized signal before acknowledging it.

Google channels use fresh UUIDs and random encrypted channel tokens with stored hashes. Headers must
match the owned channel, token and resource ID. Early `sync` messages are accepted only against the
already-persisted intent. Exact message numbers are deduplicated, but reordered/noncontiguous numbers
are not mistaken for missing permission. Renewal replaces a channel with a fresh ID; confirmation
retires the old local route. This does not claim the remote old channel was explicitly stopped.
[Google push lifecycle](https://developers.google.com/workspace/calendar/api/guides/push).

Microsoft subscriptions are primary-calendar metadata-only `/me/events` notifications. Known IDs
renew through PATCH and reconcile through GET, never another creation POST after uncertainty. Verified
lifecycle hints request renewal/reconciliation. Notifications require the persisted subscription ID
and random `clientState`; resource payloads never establish authority or enter stored transcript data.
The validation handshake only echoes a bounded token as non-cacheable plaintext, with no database or
subscription grant. HTTP 404/malformed status is not no-create proof.
[Microsoft webhook lifecycle](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks),
[subscription creation](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0).

Unknown Google creation and Graph creation without a confirmed ID remain held until their requested
24-hour expiry while polling continues. There is no blind create retry or invented lookup proof.
Known-ID Graph uncertainty is lookup-only until reconciled. Local retirement removes proof and blocks
callbacks after disconnect/policy changes. Remote stop/delete cleanup is not implemented; remote
subscriptions may remain until their bounded expiry, and must not be reported as deleted remotely.

## Setup and qualification

1. Apply Integration-owned migrations `0009` and `0010` with the migration role; existing volumes and
   checksums are preserved. Use non-owner/non-superuser/non-BYPASSRLS runtime credentials.
2. Keep current read-only Google/Microsoft OAuth scopes. Connect/select the calendar and explicitly
   enable the existing connection-bound background capture grant. No Calendar.ReadWrite/event-write
   consent is needed or requested for this slice.
3. Configure `CALENDAR_PUSH_CALLBACK_BASE` to the approved HTTPS application host, for example
   `https://app.example/webhooks/v3/cells/cell-a/calendars/`. The cell must match the Account directory
   and gateway's fixed Integration origin. Arbitrary client callback URLs are rejected.
4. Gateway forwards only bounded provider bytes/headers to
   `/internal/calendar/webhooks/google` or `/internal/calendar/webhooks/microsoft`. OAuth callbacks
   remain unchanged. Graph handshake validation must reach this origin and return exact plaintext.
5. Qualify real consent/refresh, primary-calendar selection, sender TLS/domain, create/renew/expiry,
   authenticated wake-up, missed/duplicated delivery, revoked permissions and full-duration capture
   in staging before release. Microsoft national clouds/shared or secondary calendar delta/push,
   unknown-create lookup without an ID and explicit remote unsubscribe remain unsupported gates.

Local results before publication: Integration typecheck/native build, service boundaries, 22 fast
tests and 27 PostgreSQL/HTTP tests passed with zero skips. These include recurrence-safe unchanged
rounds, delayed snapshot visibility/token commit, expired cursors, deleted staging/INSERT suppression,
concurrent subscription intent, proof/resource/caller isolation, early Google sync, Graph lifecycle
renewal and unknown outcomes. They do not qualify provider admission, notification latency or Azure
operation. Final signed gateway composition, updated Linux CI and live-provider checks remain release
gates until separately verified.
