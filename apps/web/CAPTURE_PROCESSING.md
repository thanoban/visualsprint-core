# Explicit capture-processing consent

The production `CapturePanel` offers a separate, initially unchecked English AI-processing
choice when creating a capture. Selecting it adds
`processing: { consent: true, policyVersion: "english-text-v1" }` to the existing idempotent
capture command. An unchecked choice omits that field and preserves capture-only behavior.
Calendar capture permission is never inferred to authorize AI processing.

The panel loads the capture list, then the latest individual capture status and transcript
through authenticated native APIs. Individual status is necessary because the list does not
contain the owner-private processing intent. Polling is scoped and aborted on unmount;
failed authorization clears transcript and consent controls instead of retaining inaccessible
data. A loading/error barrier prevents another start command while current status is unknown.

For an owned capture with verified `processing: null`, the owner may separately opt in using
`POST /captures/{id}/processing-consent` with explicit confirmation and an idempotency key.
Pending, ready or configuration-error intents may be withdrawn through
`POST /captures/{id}/processing-consent/withdraw` with the current `expectedIntentVersion` and
an idempotency key, even before Account has returned a consent ID. `withdraw_requested` is
displayed as recorded and awaiting reconciliation, not as an already completed revocation.
There is no replacement request while withdrawal is pending and no re-enable button for a
revoked capture: the current Account tombstone makes withdrawal permanent for that capture.
A new capture requires a new explicit choice. Shared readers receive no consent commands.

Stopping capture and withdrawing automatic processing are separate operations. Withdrawal
does not delete captured text or reviewed records and an admitted capture may continue under
its original capture permission. A ready consent is only a bound authorization, not proof of
a generated summary or a configured processing consumer. Pending/configuration errors do not
silently downgrade an explicit processing request into ordinary capture.

Qualification uses controlled HTTP browser fixtures, owning Workspace PostgreSQL and signed
service identities. It covers opt-in payloads, default omission, pending withdrawal, permanent
revocation, loading/access barriers and safe transcript rendering. No paid model, Recall or
live cloud calls are made. The complete producer/consumer pipeline and real provider behavior
remain separate release gates.
