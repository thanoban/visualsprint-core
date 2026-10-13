# Proposed narrow automatic extraction authority

This is an explicit next contract, not an active endpoint. Calendar grants and raw event metadata
do not already authorize this flow. `NarrowCaptureExtraction` defines/test-drives the boundary;
durable queue, Account consent and owning HTTP adapters must be delivered before activation.

## Consent and references

Account owns a separately consented `capture_processing` grant, bound to one workspace, owner,
meeting and capture request, with version and revocation state. At capture setup, the owner is told
that English transcript text will be processed into summaries, reviewable proposals and a private
retrieval index. If automatic processing is disabled, capture is not silently reinterpreted as consent.

The grant is not WorkOS-session authority, not a calendar grant and not a project read permission.
Logout need not cancel the consented finalized processing; member/workspace revocation, consent
withdrawal and Workspace deletion barriers immediately prohibit new reads/publication.

## Proposed ingress

Only an Ingest-signed service hop may POST
`/internal/workspaces/{workspaceId}/captures/{captureId}/extractions` with exactly:

```json
{
  "schemaVersion": 1,
  "workspaceId": "UUID",
  "ownerId": "UUID",
  "meetingId": "UUID",
  "captureId": "UUID",
  "consentId": "UUID",
  "consentVersion": 1,
  "captureRevision": 1,
  "purpose": "finalized_capture_extraction",
  "policyVersion": "english-text-v1"
}
```

The existing short-lived service JWT establishes caller identity; the body does **not** establish
permission. Intelligence asks Account to validate the current exact consent and membership, then
Workspace for the current owned/unblocked meeting reference, then Ingest for the capture binding,
terminal transcript revision and coverage. Every returned ID/revision must match the proof.
Neither browser commands, tracking codes, model output nor Service Bus possession mint consent.

Account's proposed signed-Intelligence-only operation is
`POST /internal/workspaces/{workspaceId}/capture-processing/authorize`, returning only the exact
validated binding and current version. It must not expose a generic scope list. Ingest's proposed
signed-Intelligence-only evidence endpoint is
`GET /internal/workspaces/{workspaceId}/captures/{captureId}/processing-evidence?cursor=...`, with
the same current Account consent proof, bounded text pages and original segment correction revisions.
It can never query another capture, meeting, customer, project or workspace search scope.

Queue identity is `(workspaceId,captureId,captureRevision,extractorVersion)`. Duplicate/reordered
finalized events deduplicate; a newer corrected revision creates a new draft generation and
invalidates older generated output without overwriting accepted human facts. The queue persists
intent before a model request, pins source references and uses leases/fences with outbox/inbox
semantics. A lost model response may cost a retry; no exactly-once provider-billing claim is made.

## Publication and data rights

Recheck current consent, membership, exact capture revision and Workspace deletion barrier after
generation and before publication. Deletion tombstones fence in-flight publication in the owning
Intelligence transaction. Empty/missing/gapped evidence is disclosed, never generated. Generated
decision/commitment drafts remain private and review-required. Owner acceptance creates a separate
Workspace record; an external operation needs its own exact-payload approval.

Public readers use their current normal user session and meeting ACL, irrespective of the original
background grant. Background authority cannot share meetings, approve tasks or read project chat.

Before shipping: add explicit Account consent schema/HTTP tests, Workspace/Ingest restricted
context endpoints, durable consumer/outbox wiring, model-usage admission, revoke/delete races,
original-session logout continuity tests, duplicate/reordered revision tests and restore replay.
