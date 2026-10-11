# Delivery and acceptance gates

Each delivered slice includes owning schema/migration, application behavior, API/consumer,
authorized UI where applicable, tests, telemetry and status documentation. An adapter or fake
response is not a functional meeting product.

| Gate | Deliverable | Exit evidence |
|---|---|---|
| F0 | Architecture package, monorepo, typed contracts and dependency checks | Reviewed contracts; deterministic checks pass |
| F1 | WorkOS, gateway, Account, Workspace, OpenFGA; private databases/RLS; outbox/inbox | Real PostgreSQL isolation and crash/redelivery tests; private project/meeting E2E |
| F2 | Recall ingress/dispatch/stop/finalization and private pasted-link UI | Signed events, durable text, full call/stop/gap tests on all platforms |
| F3 | Google/Microsoft calendars and capture policy | Incremental sync, recurring edits/cancellation and duplicate/ad-hoc convergence |
| F4 | Summaries, reviewable facts, chats and agendas | Evidence/revision/access evaluations and complete UI flow |
| F5 | Workflow, Jira/GitHub/Linear, notifications, export and deletion | Approved action reconciliation and complete data-rights tests |
| F6 | Azure staging and migration rehearsal | Capacity, restore, rollback, live capture and founder pilot |
| Later | CRM, public API/MCP, advanced reports, Live, visual Flows | Separate feature acceptance and measured demand |

Initial release qualification: five concurrent live captures; ten admitted meetings per platform
plus denial/policy/removal cases. Measure command ACK p95 <1s, status propagation p95 <5s and
benchmark summary p95 <2min after final transcript processing. These are targets, not current results.

Security/resilience gates: zero cross-tenant/project disclosure; permission revocation before
retrieval/publication/export; stale citations; duplicate/out-of-order callbacks; restart and
lease fencing; ambiguous provider create/execute; stop cancellation races; calendar recurrence
and timezone edits; known/unknown capture gaps; unknown speaker/owner/date; prompt injection;
payload changes after approval; deletion after export; tombstones on restore.

Fast checks run locally and in PRs. Persistence/RLS tests run against real PostgreSQL and
runtime roles, never a superuser shortcut. Broker/OAuth/provider contracts have staging tests.
Browser tests drive real application APIs with controlled providers; mocks do not prove admission.
Paid live-provider tests are gated release checks, not required on every source edit.

Migration: read-only inventory → authorized text export/import → ID mapping and new embeddings →
counts/access/citation comparison → staging rehearsal → controlled cutover. No dual writers for
the same business entity. Freeze old writes for cutover, retain an export of new writes for rollback.
Keep old application/data available until rollback and restore checks pass.
