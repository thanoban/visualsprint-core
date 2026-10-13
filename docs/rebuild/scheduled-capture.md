# Deferred capture dispatch

Date: 2026-10-12. This supplies Ingest scheduling; calendar dispatch orchestration remains next.

Capture requests accept an optional UTC `startsAt`. Initial scheduling is limited to the
next fourteen days, with a five-minute past-start grace. Ingest persists `dispatchNotBefore`
one minute before the start, keeping the existing request/attempt identity and provider
configuration. Matching idempotent retries can still return the request after its original
start time; time bounds apply to initial creation, not to acknowledged replay.

Future requests remain scheduled with pending quota, without reserving a live slot or making
a provider call. The routing index sleeps them until the join window; the independent worker
then rechecks authority, obtains/reconciles Account usage admission and enters the existing
capture dispatcher. Capacity and budget are checked when due, not guaranteed when scheduled.
Unknown provider creation remains reconciliation-only; no blind duplicate bot is introduced.

Stopping before dispatch immediately cancels the intent and makes cleanup runnable, even
when the original join time is far away. Scheduler updates hold the request lock while
updating its routing reference so a stale reschedule cannot delay cancellation until that
future date. Revoked authority after quota admission prevents the first provider creation
and releases the held capacity. Authority outages do not masquerade as admission success.

The public meeting panel allows an optional device-local start time, converted to UTC for
the API, and displays the unconfirmed join window. Immediate pasted-link capture remains
the default. The same private meeting permissions, max-four-hour cap, text-only/ZDR Recall
adapter, transcript health, stop/departure confirmation and late-text drain apply.

Signed Integration callers have a dedicated internal calendar capture endpoint, requiring
an operation principal. Workspace's current grant/connection binding constrains which
meeting can be captured. Public capture endpoints still reject operation principals.
Configure Ingest `INTEGRATION_PUBLIC_JWKS` with Integration's public signing keys; no gateway
or client-supplied identity header substitutes for that proof. Normal user delegation is
rejected on this internal entry point. No real provider or paid deployment was invoked.

Real PostgreSQL tests cover future waiting without quota, due dispatch, cancellation/cleanup,
late replay and revoked pre-dispatch authority. Signed multi-service composition exercises
deferred operation-principal requests after logout. Browser tests distinguish scheduled
from joined and verify cancellation UI. These tests use controlled providers.

Next: Integration's durable occurrence-to-meeting-to-capture workflow, reschedule/cancel
reconciliation, ad-hoc convergence, incremental calendar notifications, and live-provider
qualification. This endpoint alone does not mean calendar auto-joining is fully wired.
