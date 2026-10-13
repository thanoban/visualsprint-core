# Intelligence service

Implemented local slice, 2026-10-14. This is not full model-quality or production qualification.

## Connected preparation/retrieval checkpoint

Native API/worker wiring now includes durable next-meeting preparation, reviewed Workspace facts,
revision-bound pgvector/FTS indexing, current-source retrieval, Account model usage admission and
owning cleanup. Optional features default disabled and fail closed when required configuration,
extension, migrations, signed authority or budget are unavailable. No live model call was made.

Public additions: POST `/preparations` with `{meetingId,historyScope,confirmedScope:true}` and GET
`/preparations/{jobId}`; POST `/indexes` with `{scope}` and GET `/indexes/{jobId}`; POST `/retrieval`
with `{scope,query}`. POSTs require an idempotency key. Jobs retain original sessions and private owner
scope. Preparation excludes its target from selected history, preserves accepted decisions and
commitments verbatim in `reviewedRecords`, and never calls a manual task status externally verified.
Accepted human classifications override generated findings from the same cited source.

`INTELLIGENCE_MODEL_ADMISSION_ENABLED=true` is mandatory for configured paid models.
`INTELLIGENCE_PREPARATION_ENABLED` and `INTELLIGENCE_RETRIEVAL_ENABLED` select optional features.
Separate workers use `INTELLIGENCE_WORKER_KIND=interactive|preparation|indexing`. Account owns
purpose-isolated quota/concurrency; Intelligence commits a one-shot dispatch intent before provider
I/O. Replayed/unknown reservations cannot issue another paid call, including after a worker crash.
Unknown outcomes remain conservatively accounted until reconciliation; estimates are not measured
provider tokens. A successful model response lost before publication requires operator recovery,
not an assertion of exactly-once delivery or a blind paid retry.

Original PG55438 remains available. The independently pinned qualification DB55443 contains vector
0.8.6 and its own migration/runtime roles. `INTELLIGENCE_EXTENDED_MIGRATIONS_ENABLED=true` explicitly
applies immutable `specs/0002_vector_index.sql` and `0003_preparation_jobs.sql` only after operator
extension bootstrap. Ordinary migrations include the references-only model dispatch barrier and
do not require vector. Do not reuse the original Alpine data volume in Debian/glibc. See
[qualification and activation](specs/retrieval-preparation.md).

Local evidence: 22 fast tests, eight original-DB PG/HTTP cases, 12 isolated vector/preparation
PG/HTTP cases, TypeScript and native builds. Native route/cleanup composition is included; real
Azure/model/retention/latency/cost and production restore qualification remain deployment gates.
Public chat remains extractive. Optional indexed chat is now connected as described below;
multi-turn context/pagination and explicit automatic-capture processing consent are next increments.
The separate semantic verifier is still inactive.

## Explicit indexed chat

An active retrieval adapter can serve POST `/chats/{threadId}/messages` with
`{text,retrievalMode:'indexed'}`. Omitting the field preserves the existing lexical default.
The mode is durable in the owning `0005_retrieval_mode.sql` migration and returned with each job.
Index request/status responses include `scope`, so a ready index from one project cannot label
another selected project ready. Readiness requires the private owner's exact current authorized
source fingerprint; no model or embedding call is made by the request preflight. A disabled adapter
returns `RETRIEVAL_DISABLED` (503); absent, incomplete or obsolete indexes return `INDEX_NOT_READY`
(409). There is no silent lexical fallback. Indexed queries are bounded to 6000 UTF-8 bytes.

The interactive worker pins source references before retrieval, checks current index/source
revisions, deduplicates chunk citations into authoritative segments, and separately reserves
retrieval embeddings and chat generation. Indexed answers receive a bounded 600-second lease
because their extra embedding/source-validation phase cannot fit the original 300-second lease;
ordinary jobs remain unchanged. Lease/source checks before model dispatch prevent a stale worker
from starting a paid request. Final publication and later reads still reauthorize and verify source
fingerprints. This adds semantic retrieval, not semantically verified paraphrase generation.

Local indexed checkpoint: 25 fast tests, eight original PostgreSQL tests, and 17 isolated vector/
preparation/chat tests passed, including five real database cases for the connected indexed path.
Controlled embeddings/models are used; real Azure quality, cost and archive latency remain gates.

## Ownership and runtime

Independent API (4106), worker and PostgreSQL logical database (55438 locally), migration/runtime
roles, forced tenant RLS, leased work, immutable command keys, private threads/jobs, text evidence
index and metadata outbox. No cross-service SQL/model imports. Native bundles are generated by the
common build script; runtime reads service-specific configuration in `.env.example`.

`pnpm --filter @visualsprint/intelligence typecheck`, `test`, `test:integration` and `build` verify
this service. Integration tests require the owning local PostgreSQL container and apply migrations.

## Public operations

All paths start `/api/v3/workspaces/{workspaceId}/intelligence` and require gateway-signed user
delegation. Operation principals cannot create/read chats or authorize model calls.

| Method/path                           | Input/result                                                    |
| ------------------------------------- | --------------------------------------------------------------- |
| POST `/summaries`                     | `{meetingId}` -> durable queued job (202)                       |
| GET `/meetings/{meetingId}/summaries` | Current authorized summary history                              |
| GET `/jobs/{jobId}`                   | Owned job status, validated result or invalidated source notice |
| POST `/chats`                         | `{title,scope:{kind,id}}` -> private saved thread               |
| GET `/chats`                          | Owned saved thread metadata                                     |
| POST `/chats/{threadId}/messages`     | `{text}` -> durable answer job (202)                            |
| GET `/chats/{threadId}/messages`      | Owned history with current-source authorization                 |

Mutations require `Idempotency-Key`. Scopes are meeting/project/customer/workspace; workspace uses
`id:null` and the other scopes require UUIDs. Associations never grant source access. Threads are
private to their owner, even when the underlying meetings are shared. Project/customer validity and
every meeting ACL are verified by Workspace against current Account/OpenFGA authority.

## Evidence and outputs

Only finalized complete/partial capture transcripts are used. The adapter retrieves all pages,
checks duplicate/cyclic pagination and aggregate stability, preserves human segment revision IDs,
and bounds source sets to 100 meetings and two megabytes of text. Missing/partial transcripts cause
explicit partial evidence. Source expansion is not silent truncation: oversize scopes fail closed.

Initial verified mode is **extractive**: each output claim must be a contiguous exact excerpt of its
cited current segment and revision. Decision/commitment labels are reviewable model proposals,
not confirmed facts, inferred owners/dates or executable actions. No generated missing speech,
recordings, screenshots or desktop capture exist in this service.

Summaries accept at most 180,000 characters of text; larger summaries explicitly fail pending a
durable chunked summarization slice. Default interactive chat ranks English query terms over
authorized sources and sends at most 100 segments/60,000 characters. Explicit indexed mode uses
qualified local pgvector/FTS retrieval with current authorized source revisions. Independent
semantic claim verification, multi-turn model context and archive pagination remain next slices;
they are not implied by vector search.

Jobs store original user sessions. Before generation, before publication, and before returning saved
answers, current authority and exact source fingerprints are rechecked. Logout/revocation fail
closed; no implicit calendar grant is repurposed for intelligence. Source edits or permission scope
changes invalidate published answers. User notes are never overwritten by generated text.

## Provider boundary

Azure v1 Chat Completions uses a fixed configured `*.openai.azure.com` resource and managed identity
only. No credentials enter web/browser code. Requests have no tools, explicitly `store:false`,
bounded structured text output and timeouts. Missing model configuration fails generation; the
native runtime never falls back to a test model. GPT-4.1 mini deployment version, region, role,
quota, retention policy and measured extraction quality are external release gates.

Documentation checked for adapter shape:
[OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat),
[GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), and
[Azure v1 REST/auth](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/chat).
No live or paid model call was used during development.

## Deletion and recovery

Workspace-only signed cleanup: POST `/internal/workspaces/{workspaceId}/deletions/{deletionId}`
with `{meetingId,sourceVersion}` returns `{deletionId,meetingId,participant:'intelligence',state:'complete'}`
only after the owning transaction commits. Changed targets/versions conflict. Cleanup deletes affected
summary/chat content, queued/in-flight derived jobs, command copies, evidence indexes and metadata
outbox rows, and retains a content-free deletion tombstone. Source references are pinned durably
before model execution. Deletion and publication use the same advisory locks, preventing late
in-flight results or restore/replay from resurrecting deleted meeting derivatives. Backups and
model-provider retention remain separate disclosed deployment/operations obligations.

Crashes recover expired leases with fencing tokens. Jobs retry transient failures at most three
attempts, without duplicating committed results. Native admitted calls use the same immutable
reservation and dispatch barrier after a crash, blocking a blind paid repeat but not guaranteeing
recovery of lost responses or exactly-once external billing. Metadata outbox commit
is implemented; its independent broker publisher/consumer wiring remains a later delivery step.

Local evidence: eight fast source/domain/transport fixtures, seven actual PostgreSQL/HTTP integration
tests, TypeScript and native build checks. Full gateway/browser composition, Azure managed identity,
live model evaluations, provider latency/cost and production restore replay remain separate gates.
