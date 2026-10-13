# Retrieval and preparation qualification slice

2026-10-14. Durable request/status routes, independent worker modes, signed Workspace/Account
adapters and owning deletion are connected in the native Intelligence runtime behind explicit
disabled-by-default flags. Root qualifies gateway/UI composition separately. This is local
qualification, not proof of real Azure models, production performance or managed capture success.

## Implemented modules

- `domain/indexing.ts`: complete Unicode-preserving evidence chunks, revision-bound citations and
  qualified 1536-dimension finite/nonzero vector validation.
- `application/indexing.ts`: owner/user-only indexing and retrieval; current source authorization
  before model input, before index publication and before returning ranked evidence.
- `infrastructure/azure-embeddings.ts`: fixed Azure v1 endpoint, configured embedding deployment,
  managed-identity token port, 35-second budget, 16 inputs/batch, 6000 UTF-8 bytes/input, bounded
  ordered response validation; no live call was made.
- `infrastructure/vector-schema.ts` / `vector-indexes.ts`: owning pgvector data, durable index jobs,
  atomic staged pages/cursor, fenced recovery, private command records, source tombstones and
  filtered exact cosine plus PostgreSQL FTS reciprocal-rank retrieval. Staging is not queryable;
  only complete generations with the exact current source fingerprint are returned.
- `application/preparation.ts` / `domain/preparation.ts`: pure next-meeting drafting boundary with
  explicit confirmed history scope, current target/accepted-commitment revisions, cited historical
  findings and honest unknown/open/completed task statuses. Generated drafts require owner review;
  they never assign or share meetings and never execute actions.
- `application/capture-processing.ts`: constrained automatic-extraction proof boundary. See the
  separate [proposed authority contract](capture-processing-authority.md); the proof is metadata
  and cannot authorize reads without current consent and owning-service checks.
- `application/semantic-verification.ts` / `infrastructure/azure-verifier.ts`: separate stateless
  claim/evidence verification port and bounded Azure adapter. Exact cited quotes/revisions are
  checked first; unsupported/uncertain/mismatched verdicts cannot publish. Extractor reasoning is
  rejected rather than reused as evidence. This is not yet connected to the public generation path.

Current public outputs remain extractive, not semantically verified paraphrases. The vector
adapter adds semantic retrieval, not proof that a generated claim follows from its citation.
The separate verifier boundary is tested with controlled outputs; real semantic accuracy remains
a model-evaluation gate, not a deterministic guarantee. Accepted human facts remain separate.

## Isolated database qualification

Container and new volume: `visualsprint-v3-vector-qualification`; loopback `127.0.0.1:55443`.
The existing PostgreSQL container/volume at55438 is untouched. The qualification image is pinned:

```text
pgvector/pgvector:0.8.6-pg17-bookworm@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f
```

`vector-local-init.sql` installs extension0.8.6 as the local operator, then creates private
migration/runtime roles. Applications are never superusers or BYPASSRLS. The draft
`0002_vector_index.sql` remains under `specs`, outside the ordinary migration runner. The opt-in
test applies existing owning migrations, then this draft, only to the isolated qualification DB.
Its checksum is already applied there; changes need an append-only next migration.

```powershell
pnpm exec tsx --test services/intelligence/test/vector/index.test.ts
```

Twelve actual pgvector/preparation/RLS/HTTP tests passed, including staged batch visibility and
cosine/FTS ranking, owner/tenant and current-meeting filtering, correction/logout barriers,
stale-worker fencing, target/source deletion, durable preparation and native owning cleanup.
Twenty-two Intelligence fast tests, eight original-database tests, TypeScript and native builds
passed. Test vectors
are controlled fixtures, but ranking is performed by actual PostgreSQL/pgvector, not a JavaScript
similarity replacement. No Azure service was provisioned or contacted.

Keep the isolated volume for further tests. Do not remove/reset the existing volume. Before moving
the ordinary local DB from Alpine/musl to Debian/glibc, take a logical backup and qualify restoration
into a new named volume, preserving old data. Both use PostgreSQL major17, but locale/collation
compatibility is not established by the major version alone. Operator extension/bootstrap,
production Azure availability, secret/identity/quota and restored deletion tombstones are gates.

## Activation work still required

Native setup requires `INTELLIGENCE_MODEL_ADMISSION_ENABLED=true`, a current operator-owned Account
purpose policy, pinned Intelligence signing keys on Account/Workspace, and configured Azure model
deployments/managed identity. Set preparation/retrieval flags only after their installed-table and
extension preflight passes. Worker kinds are `interactive`, `preparation` and `indexing`, allowing
independent replicas. `INTELLIGENCE_EXTENDED_MIGRATIONS_ENABLED=true` opts into immutable SQL under
this directory only after operator vector bootstrap. The original55438 volume must remain intact.
Even disabled feature tables are purged if installed, before the deletion participant acknowledges.
Provider ambiguity/reservation replay fails closed rather than causing another paid call.

1. Qualify operator bootstrap, logical backup/restore and immutable extended migrations in the
   selected deployment environment; the opt-in local activation runner is implemented.
2. Native durable indexing request/status and independent batched worker with model admission are
   implemented. Qualify signed gateway/UI/provider composition before claiming deployment readiness.
3. Replace full-transcript scope revalidation with bounded authorized source-version metadata and
   cited-segment fetch APIs before qualifying large-archive latency. Current port is correctness
   first, bounded, and does not claim low-latency100-meeting interactive performance.
4. Owning vector/preparation purge now runs before deletion acknowledgement. Qualify backup restore
   and reapply deletion tombstones before any restored index serves.
5. Explicit indexed chat is now connected behind the active retrieval feature, with durable mode,
   current ready-index preflight, source/lease fencing and separate purpose budgets. Lexical remains
   the default and there is no fallback from failed indexed mode. Persist/reauthorize multi-turn
   context and deliver archive pagination in the next increment.
6. Preparation now persists queued intent/leases before generation and uses signed reviewed
   Workspace facts, both accepted decisions/commitments and durable model admission. Qualify its
   web/gateway composition; real draft usefulness still needs founder pilots and model evaluation.
7. Connect the separately scoped automatic capture-processing consent and event inbox/outbox;
   calendar permission must never become unrestricted project/customer intelligence permission.
8. Qualify independent semantic verification, provider quota/retention, model cost, source updates,
   revoke/delete races, crash recovery and real founder workloads. No live model proof exists yet.

Primary adapter references:
[OpenAI embeddings](https://developers.openai.com/api/docs/guides/embeddings),
[Azure v1 embeddings REST](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/embeddings),
[pgvector official README](https://github.com/pgvector/pgvector/blob/master/README.md).
