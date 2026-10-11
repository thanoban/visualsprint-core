# Implementation status

Date: 2026-10-11. Branch: codex/zedex-web-rebuild.

## Implemented in the first foundation slice

- Complete linked architecture/ownership, contract, competitor, delivery and operations package.
- Isolated pnpm/Turborepo TypeScript workspace; legacy application tooling is separate.
- Zod event, assignment, transcript and operation contracts.
- Capture lifecycle transitions, finalization/coverage rules and 90-second empty-room policy.
- Supported Meet/Zoom/Teams link validation with passcode preservation.
- Recall create adapter with explicit text-only/ZDR English configuration, bounded transport,
  no redirect following, capacity classification and ambiguous-create handling without blind retry.
- Service import-boundary check and separate CI workflow.

Initial local verification passed: service import-boundary checks, TypeScript checks and
15 contract/domain/transport-fixture tests. Build and final publication checks are recorded
in the next foundation checkpoint. Dependency lifecycle scripts remain disabled for esbuild;
the platform binary is supplied through its pinned optional dependency.

## Not yet implemented / not represented as ready

WorkOS/session handling, OpenFGA runtime, PostgreSQL/Drizzle service persistence and migrations,
RLS verification, durable broker/outbox/inbox runtime, API gateway, HTTP endpoints, webhook
signature verification/consumption, provider reconciliation/stop worker, calendar sync, web UI,
AI pipeline, saved chat, approved connectors, notifications, exports/deletion and Azure Bicep.
Live and visual Flows remain later scope.

No live Recall call, meeting join, model call, Azure deployment or data migration
has been performed by this foundation slice. Unit transport fixtures are not live provider proof.
Docker engine was unavailable during initial inspection; persistence tests require real PostgreSQL.

Next slice: F1 identity/private Workspace service and real database/outbox isolation; then F2
durable signed capture ingress and UI. Do not expose the create adapter directly as a public endpoint.
