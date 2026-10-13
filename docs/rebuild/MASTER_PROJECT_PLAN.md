# VisualSprint — end-to-end master product and delivery plan

Updated: 2026-10-13. Owner-approved v3 microservices direction. This document consolidates product, engineering, operations and business-release planning. It does not claim production readiness. Existing application and data remain available until controlled cutover. Detailed contracts and migrations remain authoritative for executable behavior.

## 1. Product purpose

VisualSprint helps founders manage customer and internal meetings, remember prior conversations and follow through on commitments. Its core loop is **prepare → capture → inspect evidence → review decisions/commitments → approve external actions → verify status → prepare again**.

Primary users: founders, customer-facing teams and internal collaborators. Validate this loop with founder pilots; microservices and feature counts alone do not prove superiority over competitors.

Launch scope: web application; Meet, Zoom and Teams through a managed capture provider; scheduled and pasted-link capture; English; text-only storage. No desktop app, extension, retained recordings or screenshots at launch. CRM, public API/MCP, advanced reports, live suggestions and visual automation follow later.

## 2. User experience and information model

Users sign in, create/join a workspace, create customers and projects, connect calendars optionally, and request meeting capture. Customers may contain multiple projects. Meetings may have several owner-confirmed context associations. Meetings begin private and unassigned. Suggested associations require confirmation; assignment never grants access. Sharing is a separate explicit operation. Workspace administrators do not automatically read private meetings.

Main product surfaces: workspace dashboard; customers/projects; meeting detail; calendar connections; capture status; transcript/summary review; decisions and commitments; scoped saved chats; action approvals; preparation; notifications; exports and deletion tracking.

Example: a founder captures an Acme call, confirms its onboarding project, reviews a promise, approves a Jira task, checks confirmed task progress and receives a draft agenda for the next Acme meeting. Preparation and full task-linking UI are still unfinished.

## 3. Capture and calendar lifecycle

Scheduled path: Integration synchronizes an event occurrence → Workspace creates/updates its private meeting → owner policy authorizes capture → Ingest persists intent and reserves usage when due → Recall dispatch → authenticated provider events and transcript ingress.

Ad-hoc path: paste a supported provider URL → private meeting → the same Ingest workflow. Calendar connection is not required. Preserve join URLs/passcodes; reused URLs do not uniquely identify event occurrences. Opaque first-party tracking codes may suggest context but never authenticate or grant access. Calendar metadata stamping requires future separate write consent.

State model: scheduled → dispatching → joining → waiting_for_admission → capturing → stopping → finalizing → complete/partial/failed/cancelled. Ambiguous dispatch has a separate dispatch_unknown state. Queued is not joined; joined is not healthy transcription. Only confirmed provider evidence establishes success or denial. Reconcile uncertain creation before another bot request.

Recall is the initial provider-independent capture adapter. All create/start paths explicitly require zero retention, English low-latency transcription and no stored media. Persist transcript text before acknowledging delivery. Deduplicate segments and preserve newer/final revisions. Record missing intervals and partial coverage; never generate missing speech.

Capture runs until provider meeting-end/exit, host removal or explicit user stop. A bot alone stops after a 90-second grace period. Silence alone is not an end condition. Stop commands remain durable until departure is confirmed; late text drains before finalization. Bots cannot bypass host or organizational controls. Live joining reliability is an outstanding release gate.

Calendar OAuth tokens are encrypted and backend-owned. Explicit connection-bound background consent survives normal browser logout; disconnect, membership loss or revocation fences future work. Snapshot paging, stable recurrence identity, scheduling and cancellation are implemented. Incremental vendor synchronization, push renewal and live qualification remain outstanding.

## 4. Intelligence, review and follow-through

Processing target: finalized text → normalized revisions → evidence-linked generated proposals → validation → reviewable summary → authorized retrieval index. Intelligence owns generated content; Workspace owns accepted decisions/commitments. Human corrections take precedence. Unknown speakers, owners and dates remain uncertain/null.

Initial qualified summaries are extractive, with exact evidence excerpts. Azure GPT-4.1 mini and text-embedding-3-small at 1,536 dimensions are the model qualification targets; configured deployment availability/quota must be verified. Do not silently fall back to an unapproved vendor. Retrieval/preparation modules exist as inactive drafts; automatic finalized-capture processing needs narrowly scoped authority and durable model-budget handling.

Saved chats are private and scoped to meeting, project, customer or authorized workspace. Check access before retrieving and before publishing; invalidate derived results when sources, revisions or permissions change. Current source bounds are explicit, not silent truncation. Full conversational context and advanced retrieval remain work.

Accepted records require explicit owner confirmation and current finalized evidence. Corrections/status changes use optimistic versions. Partial/changed evidence remains visible. Actions linked to commitments require the exact accepted version, open status and current evidence, alongside current meeting ownership.

Workflow approvals bind the actor, destination, exact canonical payload and source revision. Editing invalidates approval. Integration executes only a valid approved operation; uncertain outcomes enter lookup/reconciliation, never blind retry. AI inference alone cannot close a commitment. Full accepted-record-to-action UI, verified status feedback and agenda consumption remain incomplete.

Preparation target: authorized prior history + reviewed decisions + open commitments + confirmed task status → reviewable next-meeting brief and agenda. Generated advice must remain distinguishable from accepted facts.

## 5. Microservices and ownership

| Service | Owns |
|---|---|
| Account, global | Users, membership, entitlements, usage reservations/ledger, workspace-to-cell directory |
| Workspace | Customers, projects, meetings, notes, associations, sharing intent, accepted records, agendas, deletion coordination |
| Ingest | Capture requests/attempts, stops, provider state, transcript revisions, labels, coverage |
| Integration | Calendar connections/occurrences/cursors, encrypted credentials, connector execution attempts and external references |
| Intelligence | Generated proposals, summaries, retrieval indexes, embeddings, saved chats, preparation drafts |
| Workflow | Exact-payload approvals, durable operations, reconciliation |
| Notification | Preferences, scheduled deliveries, attempts |
| Reporting | Export jobs and report projections |
| Authz | OpenFGA permission evaluation and persistent deletion barriers |
| Live, later | In-meeting suggestions with separate quota |

Gateway is stateless routing/authentication/bounded composition, with no business database or workflow engine. Each service owns its logical database, migrations and runtime/migration roles. Cell databases may share a physical PostgreSQL server; Account uses a separate server. No cross-service SQL, foreign keys or shared persistence models.

Transactions are local. Cross-service flows use authorized APIs and durable events with transactional outboxes, consumer inboxes, duplicate tolerance, aggregate versions and fenced leases. Events contain minimal references/metadata, not transcripts or credentials. Unknown external side effects require reconciliation. Deletion/revocation barriers override stale positive projections.

## 6. Code and contract structure

Node.js LTS, TypeScript, Fastify, Zod, Drizzle; React/Vite/TanStack Router; pnpm/Turborepo. Current local baseline supports Node >=22.19; CI uses 24.

`apps/web`: product UI. `services/*`: owning domain/application/http/infrastructure and tests. `packages/*`: technical contracts/authentication/observability/messaging utilities, never shared business persistence. `infra/local`: test dependencies. Azure Bicep remains to be implemented. `tests/system`: signed-service and browser composition.

Dependency direction: HTTP/events → application use cases → domain rules → infrastructure ports. CI enforces forbidden service imports. Public rebuilt APIs use `/api/v3/workspaces/{workspaceId}`. Mutations carry idempotency keys; edits carry expected versions; accepted jobs return trackable IDs. Internal requests verify both service and delegated actor. Preserve legacy callback compatibility during migration; never silently substitute response schemas.

## 7. Privacy, security and data rights

Tenant records carry workspace_id and forced PostgreSQL RLS. Runtime roles are not owners/superusers/BYPASSRLS. Tenant context is transaction-local. Current membership, object permissions and source revisions are independently checked. Model text and tracking IDs cannot authorize actions.

Credentials belong in Key Vault/server configuration, never browser bundles, event bodies or logs. Rotate credentials previously disclosed in conversations. Privacy-safe logging excludes request URLs/query values, headers, transcript bodies and raw exception text. Retention and provider processing must be clearly disclosed; zero provider retention does not mean no processing.

Exports are asynchronous and authorized again before download. Current exports cover meeting text, not complete accepted-record/agenda export coverage. Deletion blocks access immediately, then coordinates Ingest, Intelligence, Reporting, Workflow, Integration, Notification and Authz acknowledgements. Purge source/derived content and fence late workers. External task cleanup and backups have separate disclosed status/retention. Restores replay deletion tombstones before serving data.

## 8. Azure deployment and operations

Target: one regional cell, separate local/staging/production environments. Front Door Premium/WAF → stateless gateway → global Account/regional APIs. Container Apps host APIs/workers; Jobs handle scheduled maintenance. PostgreSQL Flexible Server HA, Service Bus Standard, Key Vault, text Blob storage, Web PubSub and telemetry support the fleet. Service Bus Standard must not be configured with unsupported private endpoints.

Use managed identities and GitHub workload identity, immutable images promoted by digest, backward-compatible migrations and staged rollouts. Keep capture ingress warm. Independently scale capture dispatch/text ingress, calendar work, interactive chat, summaries/indexing, task execution and exports. Bound pools/concurrency and use fair workspace queues. Separate interactive AI quota from batch processing. Add Redis/AI Search/new cells only when measured need justifies them.

Monitor correlated requests/captures, state age, queue/outbox lag, rejected webhooks, last transcript time, coverage gaps, provider failures, model usage and cost per meeting hour. Operator runbooks must cover stuck admission, unknown dispatch, stop reconciliation, credential renewal, dead-letter replay, deletion, outages and restoration.

## 9. Required setup and costs

Required configuration: WorkOS application/issuer/audience/redirects and server profile credentials; OpenFGA store/model; Recall regional key and signed lifecycle/realtime endpoints; Google OAuth and Microsoft Entra calendar applications; task connector credentials/app consent; Azure subscription/region/quota and model deployments; verified email sender/domain and managed identity permissions; production domains and service signing keys. Minimum scopes and owner consent are mandatory. Actual secrets are excluded from this document.

Email is disabled by default. Fresh verified-profile lookup has no cached-recipient outage fallback. Send intent is serialized against local opt-out/schedule changes. Provider_sent is not mailbox-delivered; bounce/delivery receipts remain a qualification gate.

Prior planning allowance: USD 1,200–1,800/month for the approved production topology, not a current quote or a pilot budget. Exact Azure/model/provider costs require repricing the executable deployment before approval. Track capture waiting time, meeting hours, tokens, network, database HA, identity/email and telemetry costs. Initial workload is five concurrent meetings and 100 hours/month. Pricing sources and assumptions are in operations.md and Notification EMAIL_SETUP.md. Do not provision paid resources without approval.

## 10. Current implementation and readiness

Published through `6006a56`: foundation/security, private customers/projects/meetings, durable capture/calendar orchestration, initial scoped summaries/chats, reviewed decisions/commitments, exact-payload actions, exports/deletion and optional verified-profile/email handling. `c210424` fixes composed review-route wiring and waits for persisted notes before browser reload.

Recent focused evidence: 13 browser cases for the commitment slice; Account five unit plus 14 database/HTTP cases; Notification six unit plus 12 database/HTTP cases; affected builds/typechecks. These use local persistence and controlled external providers. Live bot admission, Azure operation, model quality and email delivery are not proven.

Indicative planning estimate: ~70% launch development and ~35% production preparation. These are judgment estimates, not measured completion or guarantees. Historical status.md entries describe earlier checkpoints; use latest continuation entries and commits for current evidence.

## 11. Remaining delivery sequence

1. Intelligence/retrieval: qualify drafts, activate safe pgvector/FTS migration without replacing existing volumes; add narrow finalized-processing consent, event consumption, durable AI usage admission/reconciliation, source invalidation and vector deletion.
2. Preparation/chat: conversational context, accepted-record retrieval, agenda worker/API/UI and permission-aware evidence evaluations.
3. Founder follow-through: accepted-record action drafting UI, confirmed task-status feedback, broader exports and customer/project history polish.
4. Calendars/connectors: incremental sync, push subscriptions/renewal, periodic reconciliation and complete credential lifecycle.
5. Verification gaps: provision isolated accepted-review CI database, enable profile qualification gates, complete signed profile/email composition and full cross-feature tests.
6. Azure staging: Bicep/images/OIDC, actual credentials/quotas, observability, private ingress and migration rehearsal.
7. Live qualification and pilot: supported-platform admission/stop/full-duration checks, model/citation quality, task/email behavior, capacity, restoration and founder usability.
8. Controlled production cutover; expansion only after pilot evidence.

With limited development credits: one bounded agent at a time, focused checks first, publish only verified owned changes, save continuation notes. Avoid architecture rewrites or new feature branches while these release gaps remain.

## 12. Release acceptance and migration

Targets, not existing guarantees: five concurrent captures; ten admitted calls per platform plus blocked paths; capture acknowledgement p95 <1s, status propagation p95 <5s, benchmark summaries p95 <2min after finalized processing.

Test tenant/project disclosure, revoked access, citation leakage, duplicate/reordered/missing events, crashes/queue redelivery, uncertain provider writes, recurring calendar edits, full-duration stops, host removal, gaps, prompt injection, changed approvals, exports/deletion and backup restoration. Unit/contract tests provide fast feedback; real runtime-role PostgreSQL tests validate persistence; browser/signed composition validates wiring; gated live tests qualify providers.

Migration sequence: read-only inventory → authorized text import/export → preserved ID mappings → rebuilt embeddings → count/access/citation comparison → staging restore/rollback rehearsal → freeze legacy writes → controlled cutover. Retain new-write export for rollback; never operate two uncontrolled writers for the same entity. Keep legacy application/data until gates pass.

Pilot success measures: capture success and gap rates, useful/correct cited summaries, reviewed commitment adoption, approved task success, duplicate-task rate, next-brief usefulness, time saved, support load and cost per meeting hour. Document consent/retention/limitations, support escalation and incident ownership before external launch.

## 13. Supporting source-of-truth documents

- README.md: approved scope and document index.
- architecture.md / contracts.md: service ownership and detailed behavior.
- competitors.md: sourced competitor capabilities; unpublished internals remain unknown, inferred architecture is labelled.
- delivery.md / operations.md: acceptance, deployment and cost assumptions.
- continuation-2026-10-13.md: recent implementation evidence and remaining gates.
- services/workspace/ACCEPTED_REVIEW.md: review setup and limitations.
- services/notification/EMAIL_ACTIVATION.md and EMAIL_SETUP.md: email configuration, cost sources and live gates.

Maintain this master document after each verified slice. Do not convert plans into completion claims without source, test and applicable live evidence.


## 14. Top-to-bottom physical architecture

```text
Browser
  React product routes → typed same-origin API client
  Front Door/WAF → Gateway (session verification, cell routing)
    Global Account → Account-owned PostgreSQL
    Regional cell
      Workspace ↔ Authz/OpenFGA
      Integration → Workspace → Ingest → Recall
      Intelligence → authorized Workspace/Ingest reads → Azure models
      Workflow → approved Integration execution → Jira/GitHub/Linear
      Notification → authorized membership/source → optional Azure email
      Reporting → authorized source reads → text export
    Service-owned PostgreSQL databases
    Outbox → Service Bus → inbox/leased workers → local transactions
    Planned Web PubSub → minimal status events → authorized browser refetch
```

This is the target runtime topology, not proof every Azure component exists. Provider ingress authenticates original webhook bytes and persists before ACK. Public users never select internal origins or database roles.

## 15. Repository directory plan

```text
repository/
├── apps/web/                 Browser product, routes, controls and browser tests
├── services/
│   ├── gateway/              Stateless routing and identity delegation
│   ├── account/              Global membership, usage, profile authority
│   ├── workspace/            Private meeting/customer/project domain
│   ├── authz/                Permission engine adapter and deny barriers
│   ├── ingest/               Capture lifecycle and durable text ingress
│   ├── integration/          Calendar/token/task-provider adapters
│   ├── intelligence/         Evidence, chats, model and retrieval processing
│   ├── workflow/             Approval and external-operation orchestration
│   ├── notification/         Consent/preferences and delivery
│   └── reporting/            Authorized export jobs
├── packages/
│   ├── contracts/            Versioned shared transport/event schemas
│   ├── platform/             Identity, database, bounded HTTP, safe errors/logging
│   └── messaging/            Shared technical delivery primitives
├── scripts/                  Build bundling and dependency-boundary enforcement
├── tests/system/             Real signed-service/database/browser composition
├── infra/local/              Local databases, roles and Compose dependencies
├── infra/azure/              PLANNED reproducible cloud deployment
├── docs/rebuild/              Architecture, product, operations and checkpoint docs
└── .github/workflows/         Verification; future v3 deployment gates
```

Legacy source, tooling and infrastructure outside this tree remain preserved; they are not automatically part of the v3 deployment. Generated node_modules/dist/.turbo and credentials are never source-of-truth inventory.

### Standard service internals

- `src/main.ts`: API composition, configuration validation, signer pins, role validation and shutdown.
- `src/runtime.ts`, where present: shared API/worker dependency construction.
- `src/domain/`: framework-independent invariants, states and domain types.
- `src/application/`: use cases and owned interfaces; no vendor SDK or other-service persistence.
- `src/http/`: validation, delegation checks, routes and safe responses.
- `src/infrastructure/`: owning database repositories, external adapters and scoped service clients.
- `src/worker.ts`: bounded leased jobs, recovery and reconciliation.
- `src/events.ts`, where present: outbox publishing/event consumption; no business API replacement.
- `src/migrate.ts`: owning migrations using the migration role, never runtime privilege escalation.
- `migrations/`: active append-only SQL; never modify an applied checksum.
- `specs/`: inactive design/migration drafts, not picked up as released schema.
- `test/*.test.ts`: fast behavioral tests; `test/integration/`: real owning persistence/HTTP checks.
- Additional qualification/vector folders require explicit fixtures; passing ordinary tests does not imply these ran.
- `package.json`, `tsconfig.json`, `.env.example`: runtime scripts, compiler boundaries and non-secret configuration examples.

Authz currently uses a flatter source layout; do not claim the directory convention is already uniformly applied.

### Existing file responsibilities by feature

| Feature | Main source locations |
|---|---|
| Product navigation/session | apps/web/src/main.tsx, product.tsx |
| HTTP safety and UI primitives | apps/web/src/api.ts, ui.tsx |
| Organization and meetings | organization-forms.tsx, meeting-detail.tsx; Workspace application/workspace.ts |
| Capture status/commands | capture-panel.tsx; Ingest capture-service.ts, capture.ts, store.ts |
| Recall integration | Ingest recall.ts, recall-control.ts, provider-events.ts, webhook-signature.ts |
| Calendar connect/sync | calendar-oauth.ts, calendar-panel.tsx; Integration calendars.ts, oauth-calendar.ts, occurrence-normalization.ts |
| Automatic scheduling | Integration calendar-captures.ts, capture-tasks.ts, ingest-client.ts |
| Review and accepted truth | commitment-review.tsx; Workspace commitments.ts, commitment-source.ts, commitment-store.ts, commitment-routes.ts |
| Summary/chat | intelligence-panel.tsx; Intelligence intelligence.ts, evidence.ts, sources.ts, azure-model.ts |
| Approval/task execution | workflow-panel.tsx, workflow-model.ts; Workflow workflow.ts, action.ts, clients.ts; Integration action-executions.ts, action-provider.ts, action-store.ts |
| Profile/email | Account verified-profile.ts, profile-store.ts, workos-profile.ts; Notification notification.ts, azure-email.ts, email-runtime.ts |
| Export/deletion | data-rights-panel.tsx, deletion-status.tsx; Reporting reporting.ts/source-client.ts; Workspace deletion-service.ts/deletion-store.ts |
| Permissions | Workspace policy-client.ts/permissions.ts; Authz model.ts/policy.ts/deletion-* |
| Technical platform | packages/platform/src/identity.ts, database.ts, http.ts, errors.ts, logging.ts |

Paths abbreviated inside the web/service column are relative to the specified component, not new root files.

## 16. Planned file additions and activation order

These names are proposals, not existing deployed files. Prefer extending appropriate owning files rather than creating redundant wrappers.

| Planned work | Owning paths | Completion gate |
|---|---|---|
| Model usage authority | Account application/model-usage.ts, infrastructure/model-usage-store.ts; new active migration | Durable reservations/unknown cleanup/quotas tested |
| Finalized processing | Intelligence events.ts, application/capture-processing.ts, authorized processing adapter | Narrow consent, inbox dedupe, retry/deletion tests |
| Retrieval activation | Existing draft vector/index modules and reviewed next migrations | Safe PG extension/image migration, source filtering, quota and purge |
| Preparation runtime/UI | Existing draft preparation modules; apps/web/src/preparation-panel.tsx | Async job/API, citations, accepted records and revocation browser tests |
| Conversational context | Intelligence application/chat-context.ts; existing thread/job persistence | Bounded authorized history; no cross-scope leakage |
| Incremental calendars | Integration owned cursor/subscription adapters, maintenance jobs, next migration | Expiry/410 recovery, reschedule/cancel, notification authenticity |
| Task follow-through | Workspace action-linking projection/API; existing Workflow/Integration; review UI | Explicit draft/approval; confirmed status without inferred closure |
| Richer exports | Reporting owned accepted-source adapter/export schema | Reauthorization, correction/deletion and completeness tests |
| Deployment | infra/azure/main.bicep, modules/, environments/; service Dockerfiles | Compile/what-if review, cost approval, staging rollout |
| Operations | docs/rebuild/runbooks/, dashboards/alert definitions | Failure drills and operator ownership |
| Release evidence | tests/qualification/, evaluations/, migration rehearsal artifacts | Supported-platform/live/recovery/performance gates |

Existing Intelligence draft modules listed below are not automatically activated by including them in this plan. Review and coordinate each schema/API/runtime dependency before moving a draft migration.

### Proposed Azure deployment folder

```text
infra/azure/                  ALL PLANNED; not yet provisioned
  main.bicep
  modules/
    global-account.bicep
    regional-cell.bicep
    postgres.bicep
    container-apps.bicep
    service-bus.bicep
    key-vault.bicep
    blob-text.bicep
    web-pubsub.bicep
    front-door-waf.bicep
    monitoring.bicep
  environments/
    staging.bicepparam
    production.bicepparam
  README.md
```

Each deployable API/worker has its own image/revision/identity/scaling limits, connection budget and health checks. Migrations are separate release jobs. Secrets are references, never committed values. Validate tier compatibility and regional availability before deploying.

## 17. Feature delivery file checklist

For every next feature: identify owning service → update versioned contract → create immutable migration if needed → implement domain/use case/ports → owning adapter → authenticated route or consumer → native runtime wiring → UI → fast/persistence/contract/browser tests → safe telemetry → configuration/runbook → verification evidence → scoped commit/push.

No feature is complete merely because its file exists. A draft, untracked source, inactive migration, mock response or passing unit test is not a live production capability.

## 18. Complete current v3 file inventory

Snapshot: 2026-10-13, checked from this rebuild checkout. Paths below include source, tests, manifests, documentation and CI relevant to v3, not dependencies/generated files or preserved legacy code. **Published** means tracked at the current checkout; it does not mean deployed. **Draft/untracked** means not in the published checkpoint and must not be counted as activated. Directory names communicate layer responsibilities above. Refresh this snapshot when files change.


- `.github/workflows/deploy.yml` — published/tracked
- `.github/workflows/microservices.yml` — published/tracked
- `.github/workflows/quality.yml` — published/tracked
- `apps/web/.env.example` — published/tracked
- `apps/web/index.html` — published/tracked
- `apps/web/package.json` — published/tracked
- `apps/web/playwright.config.ts` — published/tracked
- `apps/web/src/api.ts` — published/tracked
- `apps/web/src/calendar-oauth.ts` — published/tracked
- `apps/web/src/calendar-panel.tsx` — published/tracked
- `apps/web/src/capture-panel.tsx` — published/tracked
- `apps/web/src/commitment-review.tsx` — published/tracked
- `apps/web/src/data-rights-panel.tsx` — published/tracked
- `apps/web/src/deletion-status.tsx` — published/tracked
- `apps/web/src/intelligence-panel.tsx` — published/tracked
- `apps/web/src/main.tsx` — published/tracked
- `apps/web/src/meeting-detail.tsx` — published/tracked
- `apps/web/src/notification-panel.tsx` — published/tracked
- `apps/web/src/organization-forms.tsx` — published/tracked
- `apps/web/src/product.tsx` — published/tracked
- `apps/web/src/styles.css` — published/tracked
- `apps/web/src/ui.tsx` — published/tracked
- `apps/web/src/workflow-model.ts` — published/tracked
- `apps/web/src/workflow-panel.tsx` — published/tracked
- `apps/web/test/api.test.ts` — published/tracked
- `apps/web/test/browser/commitment.spec.ts` — published/tracked
- `apps/web/test/browser/intelligence.spec.ts` — published/tracked
- `apps/web/test/browser/notification.spec.ts` — published/tracked
- `apps/web/test/browser/workflow.spec.ts` — published/tracked
- `apps/web/test/browser/workspace.spec.ts` — published/tracked
- `apps/web/test/calendar-oauth.test.ts` — published/tracked
- `apps/web/test/commitment-fixture.tsx` — published/tracked
- `apps/web/test/commitment.html` — published/tracked
- `apps/web/test/fixture.tsx` — published/tracked
- `apps/web/test/index.html` — published/tracked
- `apps/web/test/vite.config.ts` — published/tracked
- `apps/web/test/workflow.test.ts` — published/tracked
- `apps/web/tsconfig.json` — published/tracked
- `apps/web/vite.config.ts` — published/tracked
- `docs/rebuild/MASTER_PROJECT_PLAN.md` — draft/untracked
- `docs/rebuild/README.md` — published/tracked
- `docs/rebuild/architecture.md` — published/tracked
- `docs/rebuild/automation-principals.md` — published/tracked
- `docs/rebuild/background-calendar.md` — published/tracked
- `docs/rebuild/calendar-connections.md` — published/tracked
- `docs/rebuild/calendar-meetings.md` — published/tracked
- `docs/rebuild/calendar-sync.md` — published/tracked
- `docs/rebuild/capture-implementation.md` — published/tracked
- `docs/rebuild/competitors.md` — published/tracked
- `docs/rebuild/continuation-2026-10-13.md` — published/tracked
- `docs/rebuild/contracts.md` — published/tracked
- `docs/rebuild/delivery.md` — published/tracked
- `docs/rebuild/local-development.md` — published/tracked
- `docs/rebuild/messaging-implementation.md` — published/tracked
- `docs/rebuild/operations.md` — published/tracked
- `docs/rebuild/scheduled-capture.md` — published/tracked
- `docs/rebuild/status.md` — published/tracked
- `infra/local/account-init.sql` — published/tracked
- `infra/local/authz-grants.sql` — published/tracked
- `infra/local/authz-init.sql` — published/tracked
- `infra/local/compose.yml` — published/tracked
- `infra/local/ingest-init.sql` — published/tracked
- `infra/local/integration-init.sql` — published/tracked
- `infra/local/workspace-init.sql` — published/tracked
- `packages/contracts/package.json` — published/tracked
- `packages/contracts/src/index.ts` — published/tracked
- `packages/contracts/test/calendar-meeting.test.ts` — published/tracked
- `packages/contracts/test/contracts.test.ts` — published/tracked
- `packages/contracts/tsconfig.json` — published/tracked
- `packages/messaging/package.json` — published/tracked
- `packages/messaging/src/index.ts` — published/tracked
- `packages/messaging/test/events.test.ts` — published/tracked
- `packages/messaging/tsconfig.json` — published/tracked
- `packages/platform/package.json` — published/tracked
- `packages/platform/src/database.ts` — published/tracked
- `packages/platform/src/errors.ts` — published/tracked
- `packages/platform/src/http.ts` — published/tracked
- `packages/platform/src/identity.ts` — published/tracked
- `packages/platform/src/index.ts` — published/tracked
- `packages/platform/src/logging.ts` — published/tracked
- `packages/platform/test/http.test.ts` — published/tracked
- `packages/platform/test/identity.test.ts` — published/tracked
- `packages/platform/test/logging.test.ts` — published/tracked
- `packages/platform/tsconfig.json` — published/tracked
- `scripts/build-service.mjs` — published/tracked
- `scripts/check-boundaries.mjs` — published/tracked
- `services/account/.env.example` — published/tracked
- `services/account/migrations/0001_identity_membership.sql` — published/tracked
- `services/account/migrations/0002_capture_usage.sql` — published/tracked
- `services/account/migrations/0003_automation_grants.sql` — published/tracked
- `services/account/migrations/0004_verified_profiles.sql` — published/tracked
- `services/account/package.json` — published/tracked
- `services/account/src/application/account.ts` — published/tracked
- `services/account/src/application/ports.ts` — published/tracked
- `services/account/src/application/profile-ports.ts` — published/tracked
- `services/account/src/application/verified-profile.ts` — published/tracked
- `services/account/src/domain/membership.ts` — published/tracked
- `services/account/src/domain/usage.ts` — published/tracked
- `services/account/src/http/app.ts` — published/tracked
- `services/account/src/infrastructure/profile-runtime.ts` — published/tracked
- `services/account/src/infrastructure/profile-schema.ts` — published/tracked
- `services/account/src/infrastructure/profile-store.ts` — published/tracked
- `services/account/src/infrastructure/schema.ts` — published/tracked
- `services/account/src/infrastructure/store.ts` — published/tracked
- `services/account/src/infrastructure/workos-profile.ts` — published/tracked
- `services/account/src/main.ts` — published/tracked
- `services/account/src/migrate.ts` — published/tracked
- `services/account/test/integration/account.test.ts` — published/tracked
- `services/account/test/integration/profile.test.ts` — published/tracked
- `services/account/test/integration/usage.test.ts` — published/tracked
- `services/account/test/membership.test.ts` — published/tracked
- `services/account/test/profile.test.ts` — published/tracked
- `services/account/test/usage.test.ts` — published/tracked
- `services/account/test/verified-profile-service.test.ts` — published/tracked
- `services/account/tsconfig.json` — published/tracked
- `services/authz/.env.example` — published/tracked
- `services/authz/DELETION.md` — published/tracked
- `services/authz/local-application-init.sql` — published/tracked
- `services/authz/migrations/0001_deletion_barriers.sql` — published/tracked
- `services/authz/package.json` — published/tracked
- `services/authz/src/app.ts` — published/tracked
- `services/authz/src/bootstrap.ts` — published/tracked
- `services/authz/src/deletion-provider.ts` — published/tracked
- `services/authz/src/deletion-routes.ts` — published/tracked
- `services/authz/src/deletion-service.ts` — published/tracked
- `services/authz/src/deletion-store.ts` — published/tracked
- `services/authz/src/main.ts` — published/tracked
- `services/authz/src/migrate.ts` — published/tracked
- `services/authz/src/model.ts` — published/tracked
- `services/authz/src/policy.ts` — published/tracked
- `services/authz/test/deletion.test.ts` — published/tracked
- `services/authz/test/integration/deletion.test.ts` — published/tracked
- `services/authz/test/integration/policy.test.ts` — published/tracked
- `services/authz/test/policy.test.ts` — published/tracked
- `services/authz/tsconfig.json` — published/tracked
- `services/gateway/.env.example` — published/tracked
- `services/gateway/package.json` — published/tracked
- `services/gateway/src/application/routing.ts` — published/tracked
- `services/gateway/src/http/app.ts` — published/tracked
- `services/gateway/src/main.ts` — published/tracked
- `services/gateway/test/routing.test.ts` — published/tracked
- `services/gateway/tsconfig.json` — published/tracked
- `services/ingest/.env.example` — published/tracked
- `services/ingest/migrations/0001_durable_capture.sql` — published/tracked
- `services/ingest/migrations/0002_worker_index.sql` — published/tracked
- `services/ingest/migrations/0003_transcript_health.sql` — published/tracked
- `services/ingest/migrations/0004_event_routing.sql` — published/tracked
- `services/ingest/migrations/0005_operation_principal.sql` — published/tracked
- `services/ingest/migrations/0006_scheduled_dispatch.sql` — published/tracked
- `services/ingest/migrations/0007_calendar_command_cleanup.sql` — published/tracked
- `services/ingest/migrations/0008_meeting_deletion.sql` — published/tracked
- `services/ingest/package.json` — published/tracked
- `services/ingest/src/application/capture-provider.ts` — published/tracked
- `services/ingest/src/application/capture-service.ts` — published/tracked
- `services/ingest/src/application/ports.ts` — published/tracked
- `services/ingest/src/domain/capture.ts` — published/tracked
- `services/ingest/src/domain/meeting-url.ts` — published/tracked
- `services/ingest/src/domain/records.ts` — published/tracked
- `services/ingest/src/events.ts` — published/tracked
- `services/ingest/src/http/app.ts` — published/tracked
- `services/ingest/src/infrastructure/authorities.ts` — published/tracked
- `services/ingest/src/infrastructure/provider-events.ts` — published/tracked
- `services/ingest/src/infrastructure/recall-control.ts` — published/tracked
- `services/ingest/src/infrastructure/recall.ts` — published/tracked
- `services/ingest/src/infrastructure/schema.ts` — published/tracked
- `services/ingest/src/infrastructure/store.ts` — published/tracked
- `services/ingest/src/infrastructure/webhook-signature.ts` — published/tracked
- `services/ingest/src/main.ts` — published/tracked
- `services/ingest/src/migrate.ts` — published/tracked
- `services/ingest/src/worker.ts` — published/tracked
- `services/ingest/test/capture.test.ts` — published/tracked
- `services/ingest/test/control.test.ts` — published/tracked
- `services/ingest/test/integration/capture.test.ts` — published/tracked
- `services/ingest/test/signatures.test.ts` — published/tracked
- `services/ingest/tsconfig.json` — published/tracked
- `services/integration/.env.example` — published/tracked
- `services/integration/ACTION_EXECUTION.md` — published/tracked
- `services/integration/migrations/0001_calendar_connections.sql` — published/tracked
- `services/integration/migrations/0002_calendar_snapshots.sql` — published/tracked
- `services/integration/migrations/0003_snapshot_order.sql` — published/tracked
- `services/integration/migrations/0004_background_principals.sql` — published/tracked
- `services/integration/migrations/0005_capture_orchestration.sql` — published/tracked
- `services/integration/migrations/0006_action_execution.sql` — published/tracked
- `services/integration/migrations/0007_action_reference_cleanup.sql` — published/tracked
- `services/integration/migrations/0008_calendar_deletion.sql` — published/tracked
- `services/integration/package.json` — published/tracked
- `services/integration/src/application/action-executions.ts` — published/tracked
- `services/integration/src/application/calendar-captures.ts` — published/tracked
- `services/integration/src/application/calendars.ts` — published/tracked
- `services/integration/src/application/ports.ts` — published/tracked
- `services/integration/src/domain/occurrences.ts` — published/tracked
- `services/integration/src/domain/records.ts` — published/tracked
- `services/integration/src/domain/sync.ts` — published/tracked
- `services/integration/src/http/action-routes.ts` — published/tracked
- `services/integration/src/http/app.ts` — published/tracked
- `services/integration/src/infrastructure/account-client.ts` — published/tracked
- `services/integration/src/infrastructure/action-provider.ts` — published/tracked
- `services/integration/src/infrastructure/action-store.ts` — published/tracked
- `services/integration/src/infrastructure/capture-tasks.ts` — published/tracked
- `services/integration/src/infrastructure/ingest-client.ts` — published/tracked
- `services/integration/src/infrastructure/oauth-calendar.ts` — published/tracked
- `services/integration/src/infrastructure/occurrence-normalization.ts` — published/tracked
- `services/integration/src/infrastructure/schema.ts` — published/tracked
- `services/integration/src/infrastructure/store.ts` — published/tracked
- `services/integration/src/infrastructure/vault.ts` — published/tracked
- `services/integration/src/infrastructure/workflow-client.ts` — published/tracked
- `services/integration/src/infrastructure/workspace-client.ts` — published/tracked
- `services/integration/src/main.ts` — published/tracked
- `services/integration/src/migrate.ts` — published/tracked
- `services/integration/src/runtime.ts` — published/tracked
- `services/integration/src/worker.ts` — published/tracked
- `services/integration/test/action-provider.test.ts` — published/tracked
- `services/integration/test/integration/action-executions.test.ts` — published/tracked
- `services/integration/test/integration/capture-orchestration.test.ts` — published/tracked
- `services/integration/test/integration/connections.test.ts` — published/tracked
- `services/integration/test/oauth.test.ts` — published/tracked
- `services/integration/test/occurrences.test.ts` — published/tracked
- `services/integration/test/vault.test.ts` — published/tracked
- `services/integration/tsconfig.json` — published/tracked
- `services/intelligence/.env.example` — published/tracked
- `services/intelligence/README.md` — published/tracked
- `services/intelligence/local-init.sql` — published/tracked
- `services/intelligence/migrations/0001_intelligence.sql` — published/tracked
- `services/intelligence/package.json` — published/tracked
- `services/intelligence/specs/0002_vector_index.sql` — draft/untracked
- `services/intelligence/specs/0003_preparation_jobs.sql` — draft/untracked
- `services/intelligence/specs/capture-processing-authority.md` — draft/untracked
- `services/intelligence/specs/retrieval-preparation.md` — draft/untracked
- `services/intelligence/specs/vector-local-init.sql` — draft/untracked
- `services/intelligence/src/application/capture-processing.ts` — draft/untracked
- `services/intelligence/src/application/index-ports.ts` — draft/untracked
- `services/intelligence/src/application/indexing.ts` — draft/untracked
- `services/intelligence/src/application/intelligence.ts` — published/tracked
- `services/intelligence/src/application/ports.ts` — published/tracked
- `services/intelligence/src/application/preparation-jobs.ts` — draft/untracked
- `services/intelligence/src/application/preparation.ts` — draft/untracked
- `services/intelligence/src/application/schemas.ts` — published/tracked
- `services/intelligence/src/application/semantic-verification.ts` — draft/untracked
- `services/intelligence/src/domain/evidence.ts` — published/tracked
- `services/intelligence/src/domain/indexing.ts` — draft/untracked
- `services/intelligence/src/domain/preparation.ts` — draft/untracked
- `services/intelligence/src/http/app.ts` — published/tracked
- `services/intelligence/src/http/preparation-app.ts` — draft/untracked
- `services/intelligence/src/infrastructure/azure-embeddings.ts` — draft/untracked
- `services/intelligence/src/infrastructure/azure-model.ts` — published/tracked
- `services/intelligence/src/infrastructure/azure-verifier.ts` — draft/untracked
- `services/intelligence/src/infrastructure/preparation-schema.ts` — draft/untracked
- `services/intelligence/src/infrastructure/preparation-store.ts` — draft/untracked
- `services/intelligence/src/infrastructure/schema.ts` — published/tracked
- `services/intelligence/src/infrastructure/sources.ts` — published/tracked
- `services/intelligence/src/infrastructure/store.ts` — published/tracked
- `services/intelligence/src/infrastructure/vector-indexes.ts` — draft/untracked
- `services/intelligence/src/infrastructure/vector-schema.ts` — draft/untracked
- `services/intelligence/src/main.ts` — published/tracked
- `services/intelligence/src/migrate.ts` — published/tracked
- `services/intelligence/src/runtime.ts` — published/tracked
- `services/intelligence/src/worker.ts` — published/tracked
- `services/intelligence/test/evidence.test.ts` — published/tracked
- `services/intelligence/test/indexing.test.ts` — draft/untracked
- `services/intelligence/test/integration/intelligence.test.ts` — published/tracked
- `services/intelligence/test/model.test.ts` — published/tracked
- `services/intelligence/test/preparation.test.ts` — draft/untracked
- `services/intelligence/test/semantic-verification.test.ts` — draft/untracked
- `services/intelligence/test/sources.test.ts` — published/tracked
- `services/intelligence/test/vector/index.test.ts` — draft/untracked
- `services/intelligence/test/vector/preparation-jobs.test.ts` — draft/untracked
- `services/intelligence/tsconfig.json` — published/tracked
- `services/notification/.env.example` — published/tracked
- `services/notification/EMAIL_ACTIVATION.md` — published/tracked
- `services/notification/EMAIL_SETUP.md` — published/tracked
- `services/notification/README.md` — published/tracked
- `services/notification/local-init.sql` — published/tracked
- `services/notification/migrations/0001_notifications.sql` — published/tracked
- `services/notification/migrations/0002_provider_send_confirmation.sql` — published/tracked
- `services/notification/package.json` — published/tracked
- `services/notification/src/application/notification.ts` — published/tracked
- `services/notification/src/application/ports.ts` — published/tracked
- `services/notification/src/domain/notification.ts` — published/tracked
- `services/notification/src/events.ts` — published/tracked
- `services/notification/src/http/app.ts` — published/tracked
- `services/notification/src/infrastructure/authorities.ts` — published/tracked
- `services/notification/src/infrastructure/azure-email.ts` — published/tracked
- `services/notification/src/infrastructure/email-runtime.ts` — published/tracked
- `services/notification/src/infrastructure/schema.ts` — published/tracked
- `services/notification/src/infrastructure/store.ts` — published/tracked
- `services/notification/src/main.ts` — published/tracked
- `services/notification/src/migrate.ts` — published/tracked
- `services/notification/src/runtime.ts` — published/tracked
- `services/notification/src/worker.ts` — published/tracked
- `services/notification/test/azure-email.test.ts` — published/tracked
- `services/notification/test/integration/notification.test.ts` — published/tracked
- `services/notification/test/origin.test.ts` — published/tracked
- `services/notification/test/schedule.test.ts` — published/tracked
- `services/notification/tsconfig.json` — published/tracked
- `services/reporting/.env.example` — published/tracked
- `services/reporting/README.md` — published/tracked
- `services/reporting/local-init.sql` — published/tracked
- `services/reporting/migrations/0001_exports.sql` — published/tracked
- `services/reporting/package.json` — published/tracked
- `services/reporting/src/application/contracts.ts` — published/tracked
- `services/reporting/src/application/ports.ts` — published/tracked
- `services/reporting/src/application/reporting.ts` — published/tracked
- `services/reporting/src/domain/export.ts` — published/tracked
- `services/reporting/src/http/app.ts` — published/tracked
- `services/reporting/src/infrastructure/schema.ts` — published/tracked
- `services/reporting/src/infrastructure/source-client.ts` — published/tracked
- `services/reporting/src/infrastructure/store.ts` — published/tracked
- `services/reporting/src/main.ts` — published/tracked
- `services/reporting/src/migrate.ts` — published/tracked
- `services/reporting/src/runtime.ts` — published/tracked
- `services/reporting/src/worker.ts` — published/tracked
- `services/reporting/test/export.test.ts` — published/tracked
- `services/reporting/test/integration/exports.test.ts` — published/tracked
- `services/reporting/test/source.test.ts` — published/tracked
- `services/reporting/tsconfig.json` — published/tracked
- `services/workflow/.env.example` — published/tracked
- `services/workflow/README.md` — published/tracked
- `services/workflow/local-init.sql` — published/tracked
- `services/workflow/migrations/0001_workflow.sql` — published/tracked
- `services/workflow/migrations/0002_deletion.sql` — published/tracked
- `services/workflow/migrations/0003_event_delivery.sql` — published/tracked
- `services/workflow/migrations/0004_source_action_lookup.sql` — published/tracked
- `services/workflow/package.json` — published/tracked
- `services/workflow/src/application/contracts.ts` — published/tracked
- `services/workflow/src/application/ports.ts` — published/tracked
- `services/workflow/src/application/workflow.ts` — published/tracked
- `services/workflow/src/domain/action.ts` — published/tracked
- `services/workflow/src/events.ts` — published/tracked
- `services/workflow/src/http/app.ts` — published/tracked
- `services/workflow/src/infrastructure/clients.ts` — published/tracked
- `services/workflow/src/infrastructure/schema.ts` — published/tracked
- `services/workflow/src/infrastructure/store.ts` — published/tracked
- `services/workflow/src/main.ts` — published/tracked
- `services/workflow/src/migrate.ts` — published/tracked
- `services/workflow/src/runtime.ts` — published/tracked
- `services/workflow/src/worker.ts` — published/tracked
- `services/workflow/test/action.test.ts` — published/tracked
- `services/workflow/test/integration/workflow.test.ts` — published/tracked
- `services/workflow/tsconfig.json` — published/tracked
- `services/workspace/.env.example` — published/tracked
- `services/workspace/ACCEPTED_REVIEW.md` — published/tracked
- `services/workspace/migrations/0001_private_workspace.sql` — published/tracked
- `services/workspace/migrations/0002_event_routing.sql` — published/tracked
- `services/workspace/migrations/0003_calendar_meetings.sql` — published/tracked
- `services/workspace/migrations/0004_deletion_jobs.sql` — published/tracked
- `services/workspace/migrations/0005_commitments.sql` — published/tracked
- `services/workspace/package.json` — published/tracked
- `services/workspace/src/application/commitments.ts` — published/tracked
- `services/workspace/src/application/deletion-service.ts` — published/tracked
- `services/workspace/src/application/ports.ts` — published/tracked
- `services/workspace/src/application/workspace.ts` — published/tracked
- `services/workspace/src/domain/permissions.ts` — published/tracked
- `services/workspace/src/events.ts` — published/tracked
- `services/workspace/src/http/app.ts` — published/tracked
- `services/workspace/src/http/commitment-routes.ts` — published/tracked
- `services/workspace/src/infrastructure/account-client.ts` — published/tracked
- `services/workspace/src/infrastructure/commitment-source.ts` — published/tracked
- `services/workspace/src/infrastructure/commitment-store.ts` — published/tracked
- `services/workspace/src/infrastructure/deletion-client.ts` — published/tracked
- `services/workspace/src/infrastructure/deletion-runtime.ts` — published/tracked
- `services/workspace/src/infrastructure/deletion-store.ts` — published/tracked
- `services/workspace/src/infrastructure/policy-client.ts` — published/tracked
- `services/workspace/src/infrastructure/schema.ts` — published/tracked
- `services/workspace/src/infrastructure/store.ts` — published/tracked
- `services/workspace/src/main.ts` — published/tracked
- `services/workspace/src/migrate.ts` — published/tracked
- `services/workspace/src/worker.ts` — published/tracked
- `services/workspace/test/commitment-source.test.ts` — published/tracked
- `services/workspace/test/integration/deletion.test.ts` — published/tracked
- `services/workspace/test/integration/workspace.test.ts` — published/tracked
- `services/workspace/test/permissions.test.ts` — published/tracked
- `services/workspace/test/qualification/commitments.test.ts` — published/tracked
- `services/workspace/tsconfig.json` — published/tracked
- `tests/system/browser-flow.ts` — published/tracked
- `tests/system/bundles.test.ts` — published/tracked
- `tests/system/follow-through-services.ts` — published/tracked
- `tests/system/foundation.test.ts` — published/tracked
- `tests/tsconfig.json` — published/tracked
