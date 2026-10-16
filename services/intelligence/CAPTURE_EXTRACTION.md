# Consent-bound automatic text extraction

This is a gated local implementation, not live meeting/model qualification. All new
flags default off and Account seeds a zero budget. The old standalone
`NarrowCaptureExtraction` prototype is not wired into the native runtime.

## Connected process chain

1. The owner explicitly opts a particular capture into `english-text-v1` processing.
2. Ingest persists an independent grant intent; current Account consent and owning
   Workspace/Ingest metadata remain separate permission checks.
3. Finalization, a human transcript correction or a late grant binding wakes Ingest's
   metadata-only publication index. A separate producer checks current ready/final
   context, fences its owning transaction and atomically inserts one generation event
   and publication record. Unknown authority is deferred; hard revocation is rejected.
4. The unchanged Ingest broker-outbox publisher sends that event to `vs-ingest`.
5. Intelligence's `events.mjs` subscribes to `capture-extraction-v1`. It commits its
   owning inbox/job before acknowledgement. Duplicate event IDs cannot change payload;
   duplicate generation notifications cannot create another job. Hard revocations have
   durable rejection records; an existing deletion tombstone rejects without recreating
   deleted inbox data. Transient authority failure abandons delivery without model I/O.
6. The separate `worker.mjs` extraction process reads the exact finalized transcript
   generation through the narrow Ingest API. It reserves Account's dedicated
   `capture_extraction` budget and commits a one-shot local model dispatch intent.
   Current grant, source fingerprint, job lease and deletion checks precede model I/O
   and private draft publication. An uncertain model outcome stays held for explicit
   reconciliation; lease recovery cannot authorize another paid call.
7. The owner reads a reviewable draft through normal current user permission. Cached
   quotes are revalidated against current human-corrected evidence before returning.
   No project assignment, accepted commitment or external action is created implicitly.

## Operator setup

| Process                          | Required opt-in / configuration                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account API                      | `CAPTURE_PROCESSING_ENABLED=true`, `CAPTURE_MODEL_ADMISSION_ENABLED=true`, pinned Ingest/Intelligence service trust and the owning database migrations. Follow [the dedicated budget procedure](../account/CAPTURE_MODEL_ADMISSION.md); its initial budget is zero.      |
| Ingest API and capture worker    | `CAPTURE_PROCESSING_ENABLED=true`, Account's pinned callback key and existing service signing key/Account/Workspace origins. Ordinary capture stays separate from AI consent.                                                                                            |
| Ingest publication process       | `events.mjs`, `INGEST_EVENT_WORKER_KIND=processing`, both `CAPTURE_PROCESSING_ENABLED=true` and `CAPTURE_EXTRACTION_PUBLISH_ENABLED=true`; owning Ingest DSN, Ingest signing key and Account/Workspace origins. It does not need a Recall or model credential.           |
| Ingest ordinary events publisher | Separate default `events.mjs` process with `INGEST_EVENT_WORKER_KIND=publisher`; normal managed-identity sender access to `vs-ingest`.                                                                                                                                   |
| Intelligence API                 | `INTELLIGENCE_CAPTURE_EXTRACTION_ENABLED=true`, `INTELLIGENCE_MODEL_ADMISSION_ENABLED=true`, owning migration `0007`, configured Azure text deployment/managed identity, Account/Workspace/Ingest origins and pinned Ingest key for the dedicated signed event endpoint. |
| Intelligence events process      | Same extraction/runtime settings, `SERVICE_BUS_NAMESPACE` and receiver access to `vs-ingest/capture-extraction-v1`; optional `INTELLIGENCE_CAPTURE_SUBSCRIPTION` defaults to that subscription. Existing `vs-intelligence` outbox publication remains unchanged.         |
| Intelligence extraction worker   | Separate `worker.mjs` process, same runtime settings and `INTELLIGENCE_WORKER_KIND=extraction`. Interactive chat retains its own worker/model quota purpose.                                                                                                             |

Provision the broker subscription and least-privilege managed identities through reviewed
infrastructure. Configure keys/DSNs in the secret manager, not browser variables or source.
Enable only after native signed composition, deployment, budget and live-provider gates pass.
Turning off new processing must never disable consent withdrawal or deletion cleanup.
Installed extraction tables are purged by the existing deletion participant even with the
feature flag off. Processing consent withdrawal is not a capture stop command.

## Private APIs and result limits

The gateway's existing Intelligence prefix exposes:

- GET `meetings/:meetingId/capture-extractions`: owner-private metadata/status list.
- GET `capture-extractions/:jobId`: owner-private current-source-validated draft.

Both are relative to `/api/v3/workspaces/:workspaceId/intelligence`. Result claims use
the existing evidence-linked extractive schema, with explicit coverage, source fingerprint
and `reviewRequired: true`. These are quoted proposals, not independently verified semantic
paraphrases or human-accepted decisions. This slice does not yet add a web draft panel,
saved-chat autoindexing or automatic notifications for this separate job type.

Dedicated internal routes are:

- Ingest, Account-only POST `captures/:captureId/processing-ready-context`.
- Ingest, Intelligence-only POST `captures/:captureId/processing-evidence`.
- Intelligence, Ingest-only POST `capture-processing/events` for signed composition/ingress.

Internal paths are relative to `/internal/workspaces/:workspaceId`. Operation principals
cannot access normal transcript/project/customer APIs. Every evidence page preserves
revision identity, checks current bindings and rejects duplicate, nonfinal or inconsistent
pages. Source text is bounded at 2 MB; the complete serialized model input plus a conservative
overhead allowance is limited to 250,000 input-token upper-bound units. Larger input fails
explicitly rather than silently truncating. Chunked long-meeting extraction is a remaining
release gate. Account estimates are not represented as measured provider billing.

## Verification and remaining qualification

Owning tests use real PostgreSQL plus controlled provider/model/HTTP transports; no paid
meeting or model calls are made. They cover tenant and owner isolation, duplicate events,
publication races, corrections, withdrawal, deletion, source changes, unknown outcomes and
one-shot dispatch. The signed local foundation composition exercises the exact Account readiness
callback, dedicated model reservation, metadata producer/outbox, signed receiver, private draft
retrieval, duplicate-generation deduplication and withdrawal. Its broker hop and model are controlled;
actual Service Bus delivery/recovery and Azure model calls still require staging qualification.

Live WorkOS/Recall/Meet/Zoom/Teams, Azure identity/model availability/quota, Service Bus
delivery/recovery, production restoration and founder benchmarks remain external gates.
