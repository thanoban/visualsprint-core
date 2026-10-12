# Background calendar authority and synchronization

Date: 2026-10-12. This checkpoint enables unattended synchronization, not bot scheduling.

The owner explicitly consents, Account creates a connection-bound calendar grant, and
Integration validates that grant before enabling its versioned background policy. The UI
uses separate idempotency keys for grant creation and policy activation, retaining safe
retry behavior if either response is uncertain. It states that scheduled dispatch is not
active yet. OAuth read consent alone never enables this policy.

Integration periodically queues a fixed-window snapshot (five-minute baseline interval),
persisting the approved operation principal rather than a user login session. Its existing
page/lease/cursor pipeline resumes across crashes and refreshes tokens when needed. Logout
does not cancel an approved grant. Current grant revocation, workspace/member loss or a
connection mismatch blocks new reads and disables policy. Durable cleanup revokes the old
grant and clears its reference even after logout. Disconnect clears provider credentials.

Public user routes continue rejecting operation principals. Workspace may receive signed
Integration calendar projections under a validated operation grant, and signed Ingest
capture contexts are restricted to meetings mapped to that same calendar connection.
Neither an unrelated private meeting nor an incorrectly delegated owner is authorized.
Workspace obtains current grant context from Account; no browser-supplied connection ID
establishes authority. Ingest/Workspace keys cannot revoke grants through Integration's
cleanup capability. Missing authority wiring fails closed.

Changing calendars requires policy disable and acknowledged grant cleanup. UI selection
is disabled while policy/cleanup is active. Calendar read controls also wait for initial
calendar loading, avoiding a real concurrent-lease race found by the browser composition
test. Service unavailability remains distinct from VisualSprint session expiration.

Local tests cover consent, grant/connection mismatch, logout continuity, periodic queueing,
revocation, cleanup, genuine signed Account/Workspace authorization, private meeting scope
and browser enable/disable. Vendor calendar responses and hosted identity remain controlled.
No live provider, capture or paid Azure resource was contacted.

Remaining F3 work: incremental synchronization/notifications, event delivery, automatic
meeting projection and scheduled Ingest dispatch, reschedule/cancellation reconciliation,
ad-hoc convergence and live qualification. The new grant is also the prerequisite for that
scheduled-capture workflow; this checkpoint must not be described as automatic joining.
