# Capture-consent-bound model admission

Status: implemented native source and qualified locally against the restored owning PostgreSQL database on 2026-10-16. Migration 0008 applied unchanged; the five new database cases and the full 33-case Account database suite passed, including explicitly enabled verified-profile tests, with zero skips. No Azure/model/provider calls, resource provisioning or paid generation were performed. Local qualification is not production activation.

Local verification on 2026-10-16: 17 Account fast tests (10 new capture-admission cases), zero skips; Account typecheck/native build and service-boundary checks passed. Owning PostgreSQL qualification exercised migration 0008, locking, role grants and forced tenant isolation. Azure identities, actual provider/model calls and live end-to-end processing remain unqualified.

Applied migration SHA-256 (immutable): `0008_capture_model_usage.sql` = `d628485e61f22f5dfeb5140c998292ed50c8bd27ea0e3d3a4ad133bd580bab3f`. Corrections after this application require a new append-only migration.

## Exact restricted contracts

Pinned **Intelligence** may POST to `/internal/workspaces/:workspaceId/capture-processing/model-usage/reservations` with the original consent operation actor: `operationGrantId=consentId`, `sessionId=operation:consentId`, original owner ID and owning workspace ID. Requests are exact:

```text
{
 operationId: UUID,
 purpose: 'capture_extraction',
 proof: {consentId,expectedVersion,meetingId,captureId,policyVersion:'english-text-v1'},
 transcriptRevision: positive integer,
 maxInputTokens: integer 1..250000,
 maxOutputTokens: integer 1..6000
}
→ {reservationId,state:'held'|'unknown'|'succeeded'|'not_started',replay:boolean}
```

The client must treat **only** `replay:false` and state `held` as a fresh admission, then persist its own one-shot model dispatch intent before network I/O. A repeated reservation is recovery information, not permission to call a model again. A different transcript revision, consent version, estimate or scope on the same operation ID conflicts. Generic chat/project/summary/indexing APIs still require normal users; a capture operation cannot use them.

Cleanup uses the same pinned caller/actor and POST `/internal/workspaces/:workspaceId/capture-processing/model-usage/reservations/:reservationId/record` with exact `{operationId,outcome:'succeeded'|'unknown'|'not_started'}`. It returns only `{reservationId,state}`. The persisted workspace/owner/consent/operation/reservation binding must match. Cleanup deliberately does not call Ingest, check membership/session, fetch text or require active consent; it works after logout, revocation, deletion and feature disable. Normal-user generic cleanup cannot record this purpose.

Unknown spend continues to consume concurrency/estimated budget. It cannot become `not_started` or expire into free capacity. Confirmed success may settle it once. The ledger stores conservative reservation estimates, **not provider-measured tokens, an invoice or free usage**. No automated billing claim is introduced.

## Authority and race handling

Account first validates its current exact consent, membership, unblocked workspace and deletion/withdrawal barriers in a short owning transaction. It then signs an Account-only metadata request to the configured private Ingest origin:

```text
POST /internal/workspaces/:workspaceId/captures/:captureId/processing-ready-context
{proof,transcriptRevision}
→ {workspaceId,captureId,meetingId,ownerId,consentId,consentVersion,
   policyVersion:'english-text-v1',transcriptRevision,state:'complete'|'partial',ready:true}
```

All reply bindings must match. Ingest owns finalized/current transcript readiness and independently checks current consent and Workspace policy; the Account authorize callback is a finite metadata read, not another model-admission call. No Account database transaction/lock is held across this callback. No transcript/title/prompt is accepted in the reply.

After the callback, Account rechecks live consent/membership/deletion while holding its owning meeting/capture locks, then locks the operation/purpose, rechecks and atomically creates the usage reservation plus immutable metadata-only capture binding. Existing operator-owned quota, concurrency, uncertainty and ledger logic is reused; private service SQL/models are not imported. Intelligence must independently recheck current source/revision before model I/O and result publication. This admission does not authorize project-wide evidence, generic paid work or external actions.

## Default-disabled setup and explicit budget approval

Native new admission requires **both** `CAPTURE_PROCESSING_ENABLED=true` and `CAPTURE_MODEL_ADMISSION_ENABLED=true`; both default false. Disabling either blocks fresh Account admission while retaining existing cleanup. Configured flags alone do not enable paid processing: the new `capture_extraction` entitlement defaults to **zero concurrency and zero input/output budget**.

Append-only migration `0008_capture_model_usage.sql` extends the owning purpose/check constraints and adds forced-RLS `capture_model_bindings`. A BEFORE INSERT trigger seeds every new capture-purpose entitlement disabled, even if runtime creates the seed. Existing purpose defaults are unchanged. The runtime cannot update quota policy. An authorized operator must first seed, then separately approve limits; even an operator's INSERT values are intentionally zeroed for this purpose. A subsequent explicit operator UPDATE is required.

Production operator transaction shape (not executed against production; use the exact approved workspace and reviewed limits rather than these zero placeholders). Controlled local qualification alone approved limits on its isolated fixture workspaces:

```sql
BEGIN;
SELECT set_config('app.workspace_id','APPROVED_WORKSPACE_UUID',true);
INSERT INTO model_entitlements(workspace_id,purpose)
 VALUES('APPROVED_WORKSPACE_UUID','capture_extraction') ON CONFLICT DO NOTHING;
-- Replace all zero values only after explicit cost/usage approval and staging qualification.
UPDATE model_entitlements
 SET max_concurrent=0,monthly_input_tokens=0,monthly_output_tokens=0
 WHERE workspace_id='APPROVED_WORKSPACE_UUID' AND purpose='capture_extraction';
COMMIT;
```

Apply production migrations through the existing distinct migration role only after release approval; never edit checksums of applied migrations. Configure Account's signed private Ingest origin/key/key ID, pin Account in Ingest and Intelligence in Account, and qualify the Ingest metadata endpoint, Workspace permission checks, private cross-environment TLS and current consent. Do not introduce a public database, shared caller signing key, browser model key or generic user-session substitution to make the background path work.

Paid model deployment, managed-identity RBAC, source-aware Intelligence dispatch/consumer wiring, durable result publication, realistic latency, provider cost measurement, live revocation/deletion and restore behavior remain separate release checks. Capturing consent is not alone a spending approval. No budget is automatically raised by model output or a client request.

## Verification and retention boundaries

Fast checks exercise the restricted actor/purpose/bounds, exact replay, preflight/revocation race, zero-budget denial, source-free cleanup after disable, preserved unknown outcomes, generic-route denial, pinned signed native HTTP and bounded/mismatched readiness metadata. Controlled repositories in these checks do not prove PostgreSQL races or grants.

Five passing owning PostgreSQL cases cover parallel idempotency, zero defaults/operator-only updates, live post-callback revocation/membership checks, normal logout with explicit background consent, cleanup and uncertain estimates, tenant RLS and deletion barriers. The complete Account database suite passed 33/33 with `ACCOUNT_PROFILE_TEST_ENABLED=true`; none of the profile or capture cases were skipped. External collaborators are controlled test ports, not live WorkOS, Ingest infrastructure or model providers.

The capture bindings and estimate/outcome ledgers contain IDs/revisions and accounting metadata only, no transcript, prompt, model answer or email. They are immutable audit/uncertain-spend references, not a new meeting-content cache. A disclosed metadata retention/restore policy is still required; deleting meeting content must not silently release uncertain paid operations or imply immediate backup erasure.

Repeatable local verification commands:

```text
pnpm --filter @visualsprint/account test
pnpm --filter @visualsprint/account typecheck
pnpm --filter @visualsprint/account build
pnpm --filter @visualsprint/account exec tsx --test test/integration/capture-model-usage.test.ts
# PowerShell: $env:ACCOUNT_PROFILE_TEST_ENABLED='true'
pnpm --filter @visualsprint/account test:integration
```
