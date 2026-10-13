# Workflow implementation — 2026-10-13

Workflow is an independent API, reconciliation worker and PostgreSQL owner. It does not own calendar
tokens, provider connectors or accepted Workspace commitments. No live external action was executed.

## Implemented local vertical slice

- Owner-private task drafts bound to a current readable, owner-managed meeting version.
- Exact connection/provider/destination/title/description/date/source fingerprint approval snapshots.
- Separate explicit approval and execution commands; metadata-only outbox records commit with effects.
- Optimistic edits, stable idempotency identities, one operation per immutable approval.
- Database FK/check/trigger protections bind every execution to its approval and forbid intent mutation.
- Editing a draft invalidates approval and cancels queued execution. Already-dispatched/ambiguous actions
  cannot be silently edited or reapproved; new approvals cannot create a second uncertain task.
- Leased/fenced dispatch persists before connector I/O. Worker crash/timeout enters lookup-only recovery.
- Only authoritative `not_created` permits another creation attempt; `pending`/`unknown` never does.
- Current source permission and revision are checked before approval, execution and Integration proof.
- Approval revocation prevents future writes, but does not pretend to undo an external task.
- Forced RLS, isolated runtime/migration roles, pinned caller keys, bounded HTTP and no body/secret logs.
- Workspace-only deletion handler immediately fences recreation, purges private task/approval payloads,
  and retains metadata-only reconciliation references for previously dispatched external work.
- Dedicated web task-draft/review/execute/status panel. It requires an actually configured connector ID;
  without Integration execution configuration it does not claim successful external task creation.

## API

All public paths are under `/api/v3/workspaces/{workspaceId}` and require a normal gateway-delegated
actor. Calendar operation principals cannot approve or execute tasks. Mutating commands require an
`Idempotency-Key`; edits/approvals/execute require `expectedVersion`. Approval requires `confirmed:true`.

- `GET/POST /actions`, `GET/PATCH /actions/{actionId}`
- `POST /actions/{actionId}/approve`, `/revoke`, `/execute`
- `GET /operations/{operationId}`, `GET /actions/{actionId}/operations` (current approval)

Draft body:

```json
{
  "connectionId": "configured-connector-uuid",
  "provider": "jira",
  "destination": "CORE",
  "payload": { "title": "Reviewed task", "description": "Exact reviewed text", "dueDate": null },
  "source": { "meetingId": "authorized-meeting-uuid", "revision": 1 }
}
```

The example UUID labels are placeholders. The `revision` currently means Workspace's meeting version,
not transcript revision or accepted-commitment revision. Those richer accepted-source bindings remain
an explicit follow-through gate; this service does not manufacture an accepted Workspace commitment.

## Integration execution contract

Workflow signs as `workflow`, audience `integration`, original approving actor/workspace/session:

- `POST /internal/workspaces/{ws}/action-executions`
- `POST /internal/workspaces/{ws}/action-executions/{operationId}/reconcile`

Both receive immutable `{operationId,approvalId,payloadHash,...draft}`. Creation returns
`{state:"confirmed",externalId}`, `{state:"rejected",code}` or `{state:"unknown"}`. Reconciliation may
also return `{state:"pending"}` or `{state:"not_created"}`. **No match from a provider search is not
authoritative absence**; eventual consistency and ambiguous provider create results must remain pending.

Integration must verify `GET /internal/workspaces/{ws}/operations/{operationId}/approval` immediately
before an external write, compare the full canonical payload/connection/destination/source snapshot,
persist its own idempotent execution intent before provider I/O, and reconcile uncertainty. This read
accepts only pinned Integration caller keys and currently authorized normal actors. Model output and
an arbitrary client `approvalId` do not authorize a write. Configure `INTEGRATION_INTERNAL_URL` only
once the owning executor implements this contract; an origin being reachable is not qualification.

Integration-only `GET /internal/workspaces/{ws}/operations/{operationId}/reference-context` returns
the same exact original intent only for unknown/reconciling/confirmed operations. It requires current
owner/source access but permits lookup after approval revocation or source edits. It is not a fresh-write
approval and must never substitute for `/approval`. Deleted content returns 404. This separates
owner-confirmed existing-task lookup/status from creation authority.

## Deletion

Pinned Workspace alone calls `POST /internal/workspaces/{ws}/deletions/{deletionId}` with
`{meetingId,sourceVersion}`. It returns `{deletionId,meetingId,participant:"workflow",state:"complete"}`
after the owning purge commits. Repeated matching targets are safe; altered targets return conflict.
The caller is a cleanup capability and needs no now-revoked content-read permission.

`cleanup_executions` retains only IDs, hash, source revision, state and external reference for
Integration's separately tracked external cleanup/reconciliation. Completion does not delete external
Jira/GitHub/Linear tasks or claim an uncertain write failed. Restore must replay `deletion_tombstones`
before reads/workers; restoring only business tables without their tombstones is unsafe.

## Local setup and evidence

`local-init.sql` is local-only; PG55440, API4108. Run service-owned migrations separately from API/worker.
Production requires TLS private origins, configured signed WorkOS/Account/Workspace authority,
Key Vault service keys and a real Integration connector adapter. See `.env.example` for configuration.

Verified locally: service typecheck/native build, one canonical-contract test, ten real PG/HTTP
integration tests, web typecheck, a UI-state contract test and a controlled full-Product browser test.
Database tests cover ambiguous outcomes,
crashes, fenced workers, altered approvals, revision/access revocation, deletion and cross-tenant access.
They use controlled connector/identity authorities, not real Jira/GitHub/Linear accounts.

Own leased outbox delivery and native Azure managed-identity event publisher are implemented and
tested with a lost-acknowledgement fixture; no live broker has been contacted.

Remaining release gates: actual Integration connector OAuth/execution/reconciliation; accepted
Workspace commitment binding and verified subsequent provider status; live outbox qualification; complete
browser/system composition and hosted identity qualification; Azure deployment and operational tests.
