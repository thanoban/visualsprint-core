# Product, API and event contracts

Status: target unless listed as implemented in status.md.

## Identity and API

Base: /api/v3/workspaces/{workspaceId}. UUID public IDs; UTC timestamps; UI uses workspace timezone.
Authenticate user sessions with WorkOS and permissions with OpenFGA plus authoritative revocation
barriers. Internal calls authenticate the service AND delegated actor. Never trust tenant headers.
Admins manage the workspace but do not automatically read private meeting content.

202 responses identify durable resource/operation IDs. Billable/mutating async commands require
Idempotency-Key; matching retries return the original identity, mismatched payloads return 409.
User edits carry an expected version; stale edits return 409. Cursor pagination is bounded.
Errors expose safe codes/request IDs, never credentials, join URLs or raw provider responses.

| Owner | Public operations |
|---|---|
| workspace | customers, projects, meetings, notes, explicit assignments, separate sharing, accepted proposals, agendas, deletion |
| ingest | create capture, capture status, request stop, transcript revisions, text imports |
| intelligence | private chat threads, messages, answer operations, summaries/proposals, draft agendas |
| workflow | exact-payload approvals, execute approved operation, reconcile operation |
| reporting | create export, export status, authorized expiring download |
| integration | start/finish provider OAuth, connection health/disconnect, calendar sync settings |

Preserve legacy OAuth callback paths at the gateway until clients are migrated. V3 is not silently
substituted behind a legacy response schema.

## Projects and customer memory

Meetings start owner-private and unassigned. Suggestions are drafts: no AI, contact rule or tracking
code auto-confirms assignments. Owners may bulk-confirm. A customer may contain multiple projects;
meetings support multiple confirmed context associations. Association does not modify any ACL.
Sharing is an independent operation with explicit audience and permission checks.

Use random opaque tracking IDs and allowlisted first-party redirect destinations. Never inject
arbitrary digits into meeting URLs. Preserve provider passcodes/query values. Codes are not auth.
Optional Google private properties/Microsoft event extensions require future calendar write consent.

## Capture

Calendar: integration occurrence → workspace meeting/policy → ingest reservation/intent/outbox →
provider dispatch. Pasted link: workspace private meeting → same ingest path. Occurrence identity
includes provider connection/event/recurrence instance, not only a reusable meeting URL.

Capture states: scheduled, dispatching, dispatch_unknown, joining, waiting_for_admission, capturing,
stopping, finalizing, complete, partial, failed, cancelled. Provider terminal states cannot regress
from stale events. Admission, stream health, processing and stop confirmation are independent facts.

Persist an attempt before provider I/O. A create timeout/malformed success is dispatch_unknown.
Find the existing provider attempt before retrying. 429/507 capacity is different from host denial.
Only real provider evidence may classify HOST_DENIED/HOST_REMOVED/POLICY_BLOCKED.

All Recall start/create paths explicitly set retention:null, English prioritize_low_latency,
and no stored audio/video outputs. Subscribe to transcript.data on the realtime endpoint.
Lifecycle webhooks are separately configured in the Recall dashboard (not realtime_endpoints).
Configure authenticated webhook verification before exposing ingress. Persist text before ACK.
Schedule sufficiently ahead when possible; ad-hoc capture has different provider capacity behavior.

Keep capturing to meeting end. Explicit end, user stop, and host removal trigger durable stopping.
The bot alone has a 90-second grace period; silence is not meeting end. Drain late segments and
confirm departure before finalizing. Empty text is not successful silence without provider evidence.
Unknown coverage produces partial output. ZDR cannot replay missing data after the provider stream
is lost; persist gap intervals and never fabricate their content.

Deduplicate segment IDs, preserve newer revisions/final text, and keep uncertain speaker labels
distinct from verified people. Capture status and last transcript timestamp are visible separately.

## Intelligence and actions

Final transcript → versioned extraction → evidence validation → reviewable summary/proposals →
authorized FTS/vector index. Workspace owns confirmed facts; Intelligence owns generated drafts.
User edits are never overwritten by automatic regeneration. Unknown owners/dates remain null.

Chat scope: meeting/project/customer/workspace, limited to current authorized source set. Each claim
has source/segment/revision references. Permission/source changes invalidate retrieval caches and
derived output. Recheck before publication. Prompt content is data and never tool authorization.
Initial model qualification: Azure GPT-4.1 mini and text-embedding-3-small, 1536 dimensions.
Deployment names/versions/geography are configured and validated; no fallback to an unapproved vendor.

### Explicit capture-processing authorization

Automatic extraction requires an explicit owner consent, separate from recording/capture consent.
The additive `capture.processing.ready.v1` event carries references only: one capture with its
stable transcript revision, one meeting, and one processing consent with its positive version.
The capture reference matches the aggregate ID and version, and the actor is the consenting owner.
Operational status or usage-settlement updates do not establish a new transcript revision.

An event is a work notification, not permission. The consumer must revalidate the current narrow
consent, membership, meeting deletion barrier and transcript revision before reading evidence,
calling a model or publishing output. A processing grant does not authorize ordinary chat,
project sources or broader workspace reads. Capture stop and processing withdrawal are different
commands; withdrawal must fence unknown or delayed consent creation. Accepted human facts remain
separate from generated drafts.

The event contract is implemented; producer/consumer activation and signed end-to-end processing
remain qualification gates. Existing `transcript.finalized.v1` consumers retain their old semantics.

Workflow stores approval bound to actor, workspace, destination, canonical payload hash and source
revision. Integration executes only that approval. Changed payloads require new approval.
Provider ambiguity enters reconciliation, not retry. Returned task status informs the next agenda;
an AI inference alone never closes a commitment.

## Data rights

Workspace deletion barrier → owning-service deletion requests → purge/acknowledgements →
provider cleanup verification → completion. Include vectors, chat derivatives and exports.
Backups have separate disclosed retention; restore applies tombstones before opening reads.
Exports reauthorize all source content and retrieval; private blobs use expiring authorized links.
# Account capture usage operations

Internal signed Ingest operations (not public gateway routes):

- `POST /internal/workspaces/{workspaceId}/usage/reserve`: `{requestId,maxSeconds}`; maximum 14,400 seconds.
- `POST .../usage/settle`: `{requestId,seconds}`; measured consumption, idempotent on identical result.
- `POST .../usage/release`: `{requestId,confirmedNoCapture:true}`; requires reconciled no-capture evidence.

Tenant/request IDs identify one reservation. A changed owner or maximum is a conflict. Held
reservations count against concurrency until confirmed departure/no-capture reconciliation;
there is no automatic time-based release. Usage belongs to the UTC month when admission began.
Settlement records actual overruns without erasing spend and atomically appends the usage ledger
and metadata outbox event. Cleanup remains permitted to the signed owning Ingest service after
user session revocation; this capability grants no transcript or meeting access. Entitlement
changes are operator/billing-owned, not accepted from browser input or capture commands.
