# Approved task execution — 2026-10-13

This is an Integration-owned connector execution increment, not a claim that provider OAuth,
production credentials, or live external accounts have been qualified. No real task was created.

## Configuration and public APIs

`POST /api/v3/workspaces/{ws}/action-connections` requires a normal owner actor and an idempotency
key. Credentials are submitted only to the authenticated backend and encrypted with the existing
AES-GCM vault using workspace/connection-specific associated data. List responses expose only ID,
provider, destination, configured/disconnected state and version, never credentials or ciphertext.
Configured means persisted configuration, not verified vendor consent or connection health.

Provider bodies:

- Jira: `{provider:"jira",cloudId,projectKey,issueTypeId,credential}`. Credential is an OAuth bearer
  access token, **not** an Atlassian app client secret or an email/API-token Basic-auth credential.
- GitHub: `{provider:"github",repository:"owner/repository",credential}`. Use a narrowly scoped
  provider token with issue-write permission for the selected repository.
- Linear: `{provider:"linear",teamId,authMode:"oauth"|"api_key",credential}`.

`GET .../action-connections` is owner-private. `DELETE .../action-connections/{id}` with
`{expectedVersion}` removes stored credentials and blocks future writes. This increment does not
implement token OAuth consent/refresh/rotation; that remains an explicit integration release gate.
Never paste credentials into repository files, logs, screenshots or documentation.

## Exact approval and durable dispatch

Pinned Workflow alone calls `POST /internal/workspaces/{ws}/action-executions` and
`POST .../action-executions/{operationId}/reconcile`. Inputs match Workflow's immutable intent:
operation/approval IDs, canonical payload hash, connection/provider/destination, reviewed title,
description/date and source meeting revision. Integration fetches the current Workflow approval
before dispatch, compares the entire snapshot and hash, and checks current Account authority.

Integration commits its execution before provider I/O. One approval/operation can dispatch once;
crashes, malformed successes and transport uncertainty remain lookup-only. Search absence is never
used to authorize a second create. This adapter does not claim vendor-wide exactly-once delivery.
Provider origins are fixed, paths are validated, redirects forbidden, requests timed and bodies
bounded. Jira descriptions are encoded into ADF without inserting hidden tracking text. Unsupported
GitHub/Linear due dates are rejected before creating anything, rather than silently altering the
approved payload. Linear GraphQL partial errors remain unknown even with HTTP 200.

## Recovery and verified task status

`POST /api/v3/workspaces/{ws}/action-executions/{operationId}/reference` accepts
`{externalId,confirmed:true}`. This is explicit owner recovery for an uncertain operation, not an
automatic search match. Integration obtains current source/read context through Workflow's separate
`reference-context` endpoint and fetches the fixed-origin provider record. Destination and approved
content must match exactly. A uniquely bound external reference cannot attach to another operation.
It never edits or creates the external task. The original `/approval` remains write-only authority.

`GET .../action-executions/{operationId}/task-status` fetches the confirmed provider reference through
fresh Account and Workflow read authority. It returns the provider's observed state/name/timestamp.
No model inference closes a commitment. Wiring these observations to Workspace accepted commitments
and next-meeting agendas remains a separate feature.

## Deletion and limitations

Workspace's signed cleanup invokes `ActionExecutions.delete(...)` alongside calendar cleanup. It
purges execution payloads, writes non-resurrectable tombstones and fences in-flight completion.
Late confirmed responses retain only external identity as cleanup evidence. Existing external tasks
are not deleted automatically; `externalCleanup:"pending"` is tracked separately from local purge
acknowledgement. Credentials shared by other meetings remain scoped to their connector.

Restores must replay Workspace deletion tombstones before accepting reads or dispatch. Token expiry,
revocation, vendor policy, custom required Jira fields, real API compatibility and hosted identity
remain live qualification gates. Unknown requests can require deliberate owner reconciliation; an
unavailable lookup is not proof of failure and is not automatically retried as a new write.

## Runtime insertion

Use `PostgresActionExecutions(pool)`, `ActionExecutions(store,accountAuthority,workflowApproval,vault,
provider)`, `HttpWorkflowApproval(WORKFLOW_INTERNAL_URL,key,keyId)` and `HttpActionProvider()`.
Register `actionRoutes(app,service,gatewayAuthenticator,workflowAuthenticator)` after the calendar
app. Workflow caller keys must be pinned separately from gateway and Workspace cleanup keys.
No extra packages are required. SQL migrations 0006 and append-only 0007 are checksum-frozen.

Controlled local verification: provider HTTP fixtures, typechecking and real PostgreSQL tests cover
encrypted owner-private configuration, exact approval, idempotency, unknown/crashed creates, source
revocation, unique references, disconnect and deletion/late external evidence. This is not live API
or Azure production evidence.

## Primary API references

Jira field/ADF and creation mapping follows the [Jira issue API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
and fixed Cloud-ID routing follows [Atlassian OAuth API calls](https://developer.atlassian.com/cloud/oauth/getting-started/making-calls-to-api/).
GitHub issue creation/reads and scoped permissions follow the [GitHub issue REST API](https://docs.github.com/en/rest/issues/issues).
Linear's endpoint, key-versus-OAuth authorization and structured-error handling follow the
[Linear GraphQL guide](https://linear.app/developers/graphql). No undocumented caller-supplied Linear
issue ID is treated as an idempotency guarantee in this increment.
