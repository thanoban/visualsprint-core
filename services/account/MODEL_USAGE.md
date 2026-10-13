# Durable model usage authority — 2026-10-14

Account owns usage admission independently of Intelligence's prompts, results and provider adapters.
This slice applies owning migration `0005`, not a cross-service schema or a billing integration.

## Internal contract

Only a pinned signed Intelligence caller may use these routes. The delegated workspace must match
the URL. Operation/calendar principals are rejected; model quotas do not grant source-reading rights.

- `POST /internal/workspaces/{ws}/model-usage/reservations`
  `{operationId,purpose,maxInputTokens,maxOutputTokens}` → `{reservationId,state,replay}`.
- `POST /internal/workspaces/{ws}/model-usage/reservations/{id}/record`
  `{outcome:"succeeded"|"unknown"|"not_started"}` → `{reservationId,state}`.

| Purpose                      | Input upper-bound estimate | Output upper-bound estimate |
| ---------------------------- | -------------------------: | --------------------------: |
| preparation / summary / chat |                  1–250,000 |                     1–6,000 |
| indexing                     |                   1–96,000 |                   exactly 0 |
| retrieval                    |                    1–6,000 |                   exactly 0 |

Embedding dimensions are not output tokens. Submitted provider billing fields are rejected. These
values are conservative admission estimates, not tokenizer measurements, actual provider usage or
a money invoice. Accurate billing needs separately verified provider token/cost receipts.

## Idempotency and uncertainty

Per-operation then per-purpose transaction locks serialize admission. Exactly one creation response
has `replay:false`; every identical replay returns the original ID/state with `replay:true`. A changed
owner, purpose or estimate conflicts. `held` means capacity reserved, not permission for repeated I/O.
Intelligence must persist a fenced one-shot dispatch intent before calling its model. A duplicate
reservation, lost response or provider uncertainty never authorizes another paid request.

New reserve checks the original session, current membership and workspace block before and after
waiting for capacity locks. Intelligence independently checks current meeting ownership, source
permissions/revisions and consent before provider I/O and publication.

`unknown` retains active capacity and its reserved estimate; age alone never releases it.
`unknown → not_started` is prohibited. A confirmed success may settle an unknown reservation.
`succeeded` consumes the maximum reserved estimate exactly once; a confirmed pre-call `not_started`
releases capacity without consumption. The exact repeated outcome is idempotent; contradictory
terminal results conflict. Outcome and estimate ledgers are append-only to the runtime role.

Owner-bound record cleanup remains possible after logout or member loss, exposing only reservation
metadata. Cleanup is not a general membership, source-read or new-call grant. There is no unqualified
provider-absence search or timeout-based unknown release.

## Operator controls

Each workspace/purpose has its own entitlement and lock: chat is not starved by preparation/indexing
quota. Defaults are two concurrent operations, 1,000,000 estimated input tokens and 100,000 estimated
output tokens per UTC reservation-start month, per purpose. These are low pilot safety defaults,
not throughput or cost guarantees. A zero entitlement disables new admission.

Only the migration/operator role can change limits. Runtime may create a default row using only
workspace/purpose columns; it cannot update limits, overwrite ledgers or delete accounting records.
Operator changes must use an approved migration/admin session with the exact workspace context and
be audited. No user API accepts quota overrides. Unknown outcomes spanning a month still hold
concurrency; estimated budget booking remains attached to the reservation's original UTC month.

Blocked errors are `MODEL_CONCURRENCY_LIMIT` (429), `MODEL_QUOTA_EXCEEDED` (402),
`IDEMPOTENCY_CONFLICT`/`MODEL_OUTCOME_CONFLICT` (409) and fail-closed authority/unavailability codes.
Capacity is bounded, not a claim of FIFO queue fairness. A provider outage can require operator
reconciliation; automatic release without authoritative evidence remains forbidden.

## CI and local qualification

CI enables all Account profile tests with `ACCOUNT_PROFILE_TEST_ENABLED=true` and separately runs
Workspace accepted-review qualification. The `workspace-qualification-bootstrap` compose profile
uses the local administrator to create only the fixed `workspace_commitment_test` logical database
and test roles. It verifies existing roles/owner before changing anything and never recreates a
volume or alters the main Workspace database. The SQL is local/CI only, not a production installer.

```powershell
docker compose -f infra/local/compose.yml --profile qualification run --rm --no-deps workspace-qualification-bootstrap
pnpm --filter @visualsprint/workspace exec tsx --test test/qualification/commitments.test.ts
```

Focused tests use real local PostgreSQL with controlled signatures, zero live model/provider calls.
Local results: Account typecheck/native build, seven fast tests and twenty-two PostgreSQL/HTTP tests
passed, with all five profile qualification tests enabled and zero skips. The eight new model cases
cover concurrent replay, payload conflicts, separate chat capacity, operator-only limits, conservative
settlement, zero-output embedding estimates, owner cleanup after logout/member revocation, prior-month
unknown capacity, append-only ledgers and signed-caller/tenant isolation. The existing isolated
Workspace accepted-review suite passed all five cases after the compose bootstrap, preserving volumes.
Service-import boundaries passed. These results are not evidence that GitHub Actions has run this
unpublished workflow revision on Linux.
Production model availability/quota, tokenizer bounds, true provider billing and crash/recovery
qualification with the owning Intelligence dispatch remain separate release gates.
