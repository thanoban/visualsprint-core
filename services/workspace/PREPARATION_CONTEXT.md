# Authorized next-meeting preparation context

Workspace provides a read-only composition of the target meeting, explicitly selected authorized history and accepted human-reviewed records. Intelligence owns durable preparation jobs and generated draft storage; no service reads another service's database.

`POST /internal/workspaces/{workspaceId}/preparation-context` accepts:

```json
{
  "meetingId": "target-uuid",
  "historyScope": { "kind": "project", "id": "project-uuid" },
  "confirmedScope": true
}
```

History kinds are meeting/project/customer/workspace; only workspace uses null ID. The endpoint pins the Intelligence signing key through `INTELLIGENCE_PUBLIC_JWKS`, rejects operation principals, checks workspace/actor delegation and current target ownership, and sends `Cache-Control: no-store`. A gateway, Workflow or cleanup key is not an Intelligence credential. Main runtime registers `preparationContextRoutes` with `WorkspacePreparationContext`.

The response contains:

- `target`: ID, optimistic version and title.
- `history`: requested scope and readable meeting ID/version/title metadata. The target itself is excluded.
- `decisions` and `commitments`: accepted ID/meeting/version/title/text/state, optional owner/date, `statusSource: human_review`, updated timestamp, exact citation references, evidence status and partial flag. `externalStatus` is always `unknown`, and `externalVerifiedAt` is null in this slice. A human marking a commitment completed does not prove its external task status.

Confirmed customer/project assignments determine association only. Every history meeting must also pass current local ACL, Account membership and Authz checks. Selection never assigns or shares the target. Target ownership and history version/permission frame are checked again before publication. The current context is selected history, not an inferred chronological set: no calendar start time or temporal cutoff is invented. Only finalized transcript evidence is consumed downstream. Intelligence must filter target evidence consistently and revalidate target, source revisions and both accepted-record sets before publishing/reading a stored draft.

The context is bounded to 100 authorized meetings and 100 accepted records of each kind. Preparation requests more than that fail closed rather than returning an apparently complete truncated brief. Existing public review lists keep their separate bounded-display behavior. Source HTTP transports can fail closed; changed/unavailable evidence labels preserve human truth without generating missing speech or pretending fresh verification.

The web meeting detail mounts `PreparationPanel` for the target owner. Scope selection and explicit confirmation precede a durable `POST /intelligence/preparations`; polling reads the same returned ID. Only opaque job ID/scope metadata is retained in tab-scoped session storage, never statements or transcripts. Refresh resumes authorized polling without creating a replacement. Complete results are periodically reauthorized; outages, revocation, invalidation, scope/revision changes and unmount clear displayed private data. Proposal findings, accepted history and agenda questions remain visibly distinct; nothing approves or executes an external action.

Qualification uses local owning PostgreSQL, signed controlled service identities and browser fixtures; no paid/live model or provider was contacted. Run Workspace integration and unit tests plus the preparation browser cases. Real identity/keys, durable Intelligence composition, model-budget admission and Azure/live release qualification remain separate gates. This context adds no Workspace tables or migrations.
