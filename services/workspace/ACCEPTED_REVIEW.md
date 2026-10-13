# Accepted decisions and commitments

## Activated slice

Workspace owns human-reviewed records, not model-generated truth. Migration `0005_commitments.sql` owns `accepted_items` and payload-hash-only idempotency commands, with forced workspace RLS and the Workspace runtime role. Apply ordinary append-only Workspace migrations before deploying the new API or deletion worker; never edit an applied migration.

`main.ts` registers review routes and an authorized source adapter. `INGEST_INTERNAL_URL` enables finalized transcript revision verification. Optional `INTELLIGENCE_INTERNAL_URL` enables loading a generated proposal by authenticated job reference. Both origins are operator-configured and transport-bounded. Missing source configuration blocks acceptance; existing human-reviewed records may remain readable but are explicitly labelled as evidence unavailable.

The Workspace signing key must be pinned by Ingest as `WORKSPACE_PUBLIC_JWKS` for its evidence-batch endpoint and by Intelligence for its GET-only job reader. `WORKFLOW_PUBLIC_JWKS` in Workspace pins the separate accepted-commitment source reader. These are delegated normal-user reads, not cleanup-operation permissions.

## Public API

Under `/api/v3/workspaces/{workspaceId}`:

- `GET /decisions` and `/commitments`: authorized meeting/project/customer/workspace scope, at most 100 of each kind. Project association never grants meeting access.
- `POST /decisions` or `/commitments`: current meeting owner, `confirmed:true`, current meeting version, exact evidence references, and an idempotency key.
- `GET /{kind}/{id}`: currently authorized meeting reader.
- `PATCH /{kind}/{id}`: owner-reviewed correction, optimistic item/meeting versions, exact current evidence references and a new idempotency key. Corrections are not overwritten by model regeneration or old command replay.
- `POST /{kind}/{id}/status`: explicit owner-confirmed human status, optimistic item version and idempotency key. This performs no external task write.

Optional responsible members must be current workspace members. Unknown owners/dates stay null; decision records have neither. Evidence is verified before persistence, including finalized segment revisions and capture-to-meeting binding. Partial evidence remains labelled partial; edited human text is not represented as automatically proven by a citation.

Workflow-only `GET /internal/workspaces/{workspaceId}/commitments/{id}/source` returns `{id,meetingId,version,title,text,ownerId,dueDate,state,evidenceStatus,humanReviewed:true}` after current source-read authorization. Item version changes on correction or status edits. New external writes must independently require current meeting ownership, exact accepted version, open status and current evidence, plus exact-payload approval. Historical human truth remains visible as changed/unavailable evidence; it must not silently authorize a new write.

## UI and deletion

The meeting detail mounts `CommitmentReview`. Owners select an authenticated generated excerpt, write/review the exact statement, explicitly choose any known member/date, and tick confirmation before acceptance/correction. Shared readers see accepted records without mutation controls. Scope changes unmount private values. The existing task drafting/approval UI remains separate; it does not yet offer one-click linkage to an accepted item.

Workspace deletion atomically blocks the meeting and erases accepted records in its existing deletion transaction. Command metadata retains only fingerprints/IDs; stale command replay cannot recreate deleted content. Completion still depends on every required service acknowledgement, not just Workspace's local purge. Metadata-only outbox events contain no reviewed statement text.

## Verification and remaining gates

Local checks cover input validation, signed authoritative source parsing, partial revisions, null unknowns, human corrections, idempotent late replay, tenant isolation, independent sharing, revoked reads, deletion purge, public HTTP guards and the Workflow-only source DTO. Controlled browser tests cover explicit review confirmation, script escaping, reader restrictions and private scope reset.

Commands:

```powershell
pnpm --filter @visualsprint/workspace test
pnpm --filter @visualsprint/workspace test:integration
pnpm exec tsx --test services/workspace/test/qualification/commitments.test.ts
pnpm --filter @visualsprint/web test:browser
pnpm --filter @visualsprint/workspace build
pnpm --filter @visualsprint/web build
```

The additional qualification suite uses the explicitly created local `workspace_commitment_test` database on port 55433 and dedicated `vs_commitment_test_migration` / `vs_commitment_test_runtime` roles. It refuses a different database, applies owning migrations without resetting data, and creates randomly isolated fixture workspaces. It is intentionally outside the default integration glob: CI needs an explicit isolated-database provisioning/run step before claiming this qualification there. The ordinary integration suite applies migration 0005 to its configured local Workspace test database.

This is local controlled-source qualification, not proof of real provider capture, live identity/keys, Azure deployment, model quality, capacity or production migration. No paid model calls or external writes were used. Accepted-item action linkage UI, next-agenda consumption and export inclusion require their own follow-on verification; existing meeting-only exports must not be described as complete accepted-record exports.
