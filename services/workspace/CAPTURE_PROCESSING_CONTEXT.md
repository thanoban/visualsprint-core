# Scoped automatic-processing context

Workspace provides one dedicated metadata interface for explicitly consented automatic English transcript processing. This does not widen ordinary Workspace membership, meeting reads, chats, project access or integration approvals.

`POST /internal/workspaces/{workspaceId}/meetings/{meetingId}/capture-processing-context` is pinned to the Ingest and Intelligence signing keys, and requires a processing operation actor:

```json
{
  "consentId": "consent-uuid",
  "expectedVersion": 1,
  "meetingId": "meeting-uuid",
  "captureId": "capture-uuid",
  "policyVersion": "english-text-v1"
}
```

The operation grant ID must equal the consent ID and its session must be `operation:{consentId}`. Meeting IDs in the body and route must match. The Workspace adapter calls Account's signed `POST /internal/workspaces/{workspaceId}/capture-processing/authorize`; exact consent, owner, workspace, meeting, capture, policy and version must match an active current proof. Account owns current consent/member/workspace validation, including withdrawal; a normal user session or a calendar operation grant is not processing authority.

After Account authorization, Workspace queries only owning meeting ID/owner/version/deletion metadata under forced workspace RLS. It checks current owner and unblocked state, reauthorizes with Account, then rereads metadata to fence a concurrent deletion or version change. Response is only `{meetingId,ownerId,meetingVersion}` with `Cache-Control: no-store`: no notes, join URLs/passcodes, transcripts, customer/project data or reader lists.

`CaptureProcessingContext`, `PostgresProcessingMeetings`, `AccountCaptureProcessing` and `captureProcessingContextRoutes` are registered in the native Workspace runtime. `INGEST_PUBLIC_JWKS` / `INTELLIGENCE_PUBLIC_JWKS` pin callers, and the existing Workspace signer authenticates to Account. No migration is required. Unconfigured/failed Account authority fails closed, without logging response content or credentials.

The mounted CapturePanel controls are an independent explicit choice, not implied by calendar/capture consent. Pending setup is not a ready worker or summary. Withdrawal must be a durable processing command, including when grant creation has not returned an ID: it fences late creation and reports `withdraw_requested` until reconciliation confirms revocation. Stop capture is separate; revoked processing can coexist with ordinary capture under its original consent. Previously captured or reviewed data is not silently deleted by consent withdrawal. Withdrawal is permanent for the current capture; no re-enable command is offered. See `apps/web/CAPTURE_PROCESSING.md` for native API and UI behavior.

Workspace authorization is not the Ingest dispatch barrier: while a durable withdrawal is awaiting Account reconciliation, the capture-owning service must also verify that the intent is still ready before any processing dispatch. An Account proof alone does not establish that a pending Ingest withdrawal permits work.

Qualification covers owning PostgreSQL tenant/owner/deletion barriers, strict signed service/operation identities, exact Account proof bindings, revocation/version-change rechecks and metadata-only output. These use local persistence and controlled Account/provider responses, not live cloud credentials or successful model execution. Account consent lifecycle, Ingest intent/reconciliation, finalized-capture events, model admission and Intelligence workers must be verified together before claiming automatic processing is complete.
