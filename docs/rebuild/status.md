# Implementation status

Date: 2026-10-12. Branch: codex/zedex-web-rebuild.

## Implemented in the first foundation slice

- Complete linked architecture/ownership, contract, competitor, delivery and operations package.
- Isolated pnpm/Turborepo TypeScript workspace; legacy application tooling is separate.
- Zod event, assignment, transcript and operation contracts.
- Capture lifecycle transitions, finalization/coverage rules and 90-second empty-room policy.
- Supported Meet/Zoom/Teams link validation with passcode preservation.
- Recall create adapter with explicit text-only/ZDR English configuration, bounded transport,
  no redirect following, capacity classification and ambiguous-create handling without blind retry.
- Service import-boundary check and separate CI workflow.

Local verification passed: frozen-lockfile installation, service import-boundary checks,
TypeScript checks, 15 contract/domain/transport-fixture tests and compilation of both packages.
Rebuild document links and Git whitespace checks passed. These are local Windows results;
the new GitHub Actions workflow independently checks Linux after publication.
Dependency lifecycle scripts remain disabled for esbuild; the platform binary is supplied
through its pinned optional dependency.

Architecture checkpoint: `cd93c4e`, pushed to `origin/codex/zedex-web-rebuild`.
The code foundation is published as a separate checkpoint following those checks.

## Not yet implemented / not represented as ready

WorkOS login/refresh and Account membership runtime, OpenFGA runtime, Azure broker adapter/daemon,
API gateway, capture HTTP endpoints, webhook
signature verification/consumption, provider reconciliation/stop worker, calendar sync, web UI,
AI pipeline, saved chat, approved connectors, notifications, exports/deletion and Azure Bicep.
Live and visual Flows remain later scope.

No live Recall call, meeting join, model call, Azure deployment or data migration
has been performed by this foundation slice. Unit transport fixtures are not live provider proof.
Docker is available and the Workspace integration suite uses PostgreSQL 17.6.

## Workspace persistence/API slice (F1 in progress)

- Independently runnable Fastify Workspace service with service-owned Drizzle schema/migration.
- Customers/projects, private meetings/notes, explicit assignment, sharing/revocation and versioned edits.
- Forced tenant RLS, distinct runtime/migration roles and startup rejection of unsafe runtime roles.
- Commands and events commit atomically; concurrent idempotency keys are serialized and payload conflicts fail.
- PostgreSQL outbox leases/fencing and transactional consumer inbox withstand duplicate delivery/crashes.
- Signed service delegation binds caller key, audience, tenant and actor; WorkOS JWT verification utility.
- Real database/HTTP integration tests and CI dependency setup; controlled membership authority in tests.

Verification: 18 fast tests, all four packages typechecked/compiled, and eight real
PostgreSQL/HTTP integration tests passed locally on 2026-10-12. Account is a controlled
membership provider in this suite; actual inter-service Account wiring is the next slice.

F1 remains open until Account/WorkOS login, OpenFGA, gateway, web UI and broker wiring pass together.
Next slice: Account identity/membership/cell directory and gateway; then F2
durable signed capture ingress and UI. Do not expose the create adapter directly as a public endpoint.
