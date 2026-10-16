# VisualSprint continuation — 2026-10-16

## Source of truth and safety boundaries

Worktree: `C:/Users/thano/.codex/worktrees/visualsprint-microservices/MeetForge`.
Branch: `codex/zedex-web-rebuild`; remote: `thanoban/visualsprint-core`.
The original legacy checkout, production data, Docker volumes and unrelated study-roadmap
edits are preserved. Do not reset volumes or rewrite previously applied migrations.

The approved v3 plan remains unchanged: independently owned service databases, signed
delegation, owner-confirmed customer/project associations separate from sharing, English
text-only managed Recall capture and Azure. No screenshots, stored recordings, extension
or desktop client have been reintroduced.

## Published implementation slices

| Commit    | Completed implementation                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `6038e32` | Azure source modules, private database bootstrap, operator configuration and offline CI                                              |
| `0f66faa` | Human-reviewed commitment source/version carried through exact-payload approval and separate execution UI                            |
| `e942bc3` | Dedicated consent-bound Account capture-extraction admission and immutable model reservation bindings                                |
| `21fb7fd` | Owner-reviewed agenda persistence, optimistic mutations and Reporting-pinned complete Workspace export snapshots                     |
| `8d162e4` | Reviewed agenda UI and complete schema-2 export downloads with explicit legacy schema-1 handling                                     |
| `ffbad53` | Durable consent withdrawal after logout/feature-disable, complete capture export manifest and finalized-generation metadata producer |
| `160a305` | Complete reviewed-record exports, current evidence/context fingerprints and expiry/worker fences                                     |
| `a933d22` | Durable Intelligence inbox/extraction worker, exact-generation evidence, current-consent admission and one-shot paid dispatch        |
| `cb77a2c` | Explicitly ordered outbox claims before lease/deletion delivery checks                                                               |
| `e655854` | Owner-private extraction result authorization through normal meeting reads without widening internal caller access                   |
| `4a33e8a` | Gated Azure processing/extraction workers and subscription-scoped event delivery identity                                            |
| `f7460ae` | Signed automatic-extraction/agenda/export composition and Docker-free cross-service export-contract CI                               |

These are implementation checkpoints, not a production-readiness declaration. New processing
flags default off. Account's new capture-extraction budget starts at zero. Explicit owner
opt-in and operator-configured budget are both required; ordinary capture is independent.

## How the automatic path is wired

Owner opt-in → durable Ingest consent intent → Account scoped grant → finalized transcript
revision → Ingest metadata publication/outbox → `vs-ingest/capture-extraction-v1` → Intelligence
inbox/private job → current grant/source checks → dedicated Account budget reservation →
fenced model call → reviewable private evidence-linked draft.

Ingest's processing producer is separate from its ordinary event publisher. Intelligence's
extraction worker is separate from interactive chat. The Azure source adds both processes,
the named subscription and receiver-scoped identity grant, behind explicit activation guards.
No transcript text is carried in domain events. Unknown model outcomes retain reservations;
neither queue replay nor expired-lease recovery authorizes another paid call.

Consent withdrawal is not a capture stop request. Withdrawal cleanup survives logout and
feature-disable. Deletion fences new work and purges installed extraction tables even with
new processing disabled. Reviewed agendas are human-owned; generated preparation stays draft.

## Docker-backed verification and corrections

Docker Compose dependencies are healthy; existing PostgreSQL volumes were preserved.
The repository check (boundaries, all-package typechecks/unit tests and composition typecheck),
all-package build and three cross-service offline export-contract tests passed locally. The full
`pnpm test:integration` passed after corrections with `ACCOUNT_PROFILE_TEST_ENABLED=true`,
including all ordinary owning-service suites and five system/bundle/offline tests. The separate
isolated accepted-record suite passed five tests; real pgvector retrieval/preparation passed
17 tests on the existing isolated qualification database at 55443, with no skipped tests.
Reporting passed 12 fast/signed-transport and seven real PostgreSQL tests. Workspace previously
passed 14 fast, 27 PostgreSQL and five isolated accepted-record tests. Ingest passed 28 fast
and 33 PostgreSQL/HTTP tests. Account passed 17 fast and 33 PostgreSQL tests with profile tests
explicitly enabled. Intelligence extraction initially passed 36 fast and 17 PostgreSQL tests.

A broader repeat exposed an existing outbox ordering defect: an ordered candidate CTE does
not make `UPDATE ... RETURNING` ordered. The corrective query explicitly orders claimed rows;
a regression inserts events in a different heap order and tests chronological delivery plus
lease-expiry/deletion fencing. The corrected Intelligence PostgreSQL suite passes 18 tests.

The signed foundation composition also checks actual owner agenda creation, complete JSON
export, private-reader denial and invalidation of a previous export after agenda correction.
The extended automatic extraction composition passed against real Account/Ingest/Workspace/
Intelligence databases and signed HTTP. It exercises the finalized-generation producer/outbox,
Ingest-pinned receiver, native Account readiness callback and dedicated budget admission, then
reads the private draft through the gateway. Replaying the event or sending another envelope for
the same generation produces exactly one model call. Withdrawal rejects new work. Only the model,
hosted identity/providers and broker hop are controlled. All 36 web browser tests also passed.

This composition found an owner-read adapter incorrectly calling Workspace's Ingest-only
manage-context route. The fix uses the existing authorized public single-meeting read and checks
owner identity; it does not expand internal route access or allow operation grants to read meetings.

Azure source validation compiled ten Bicep files and passed 15 activation/security guards.
An isolated Docker PostgreSQL bootstrap test passed, including non-superuser roles and replay
fences. This validation uses no Azure credentials and creates no cloud resources.

Independent Linux GitHub Actions also passed for `f7460ae`: both `azure-source` and `verify`
completed successfully in [run 38839508546](https://github.com/thanoban/visualsprint-core/actions/runs/38839508546).
That includes frozen dependency installation, check/build, offline contracts, browser tests,
Docker dependencies, profile-enabled integration tests and isolated accepted commitments.
The subsequent checkpoint publication changes documentation only.

## Remaining development and release gates

1. Add the automatic extraction draft/status panel and explicit human review path to the web
   application. Its private APIs exist; this separate job type has no dedicated UI or automatic
   notification yet. Existing manual summaries/chats and accepted-record review remain separate.
2. Implement bounded long-transcript chunking/reduction. Current extraction explicitly rejects
   inputs above its conservative 250,000-unit serialized-input bound; do not silently truncate
   or claim every long meeting is supported.
3. Connect/qualify native Blob and Web PubSub behavior and operational telemetry/alert delivery.
   Provisioning source is not proof that application adapters use those resources.
4. Qualify live WorkOS, Recall, Meet/Zoom/Teams admission/full-duration/stop behavior, Google/
   Microsoft calendar push renewal, task-provider execution, Azure model quota and broker
   delivery/recovery with approved staging credentials and budget.
5. Run five-concurrent capture/load targets, backup restoration with deletion tombstones,
   migration rehearsal/rollback and founder quality benchmarks before production cutover.

No paid model/provider requests, Azure deployment or migration of production data occurred
in these local slices. Calendar push retirement still relies on subscription expiration.
Existing application URLs/OAuth callback compatibility must be retained during cutover.

## Resume commands and publication discipline

Check git status/upstream and Docker health first. Run `pnpm check`, `pnpm build`,
`pnpm test:offline`, web browser tests and `pnpm test:integration`; set
`ACCOUNT_PROFILE_TEST_ENABLED=true` when qualifying profiles. Isolated commitment and vector
qualification have their own opt-in database fixtures; ordinary integration does not imply them.
Use the pinned `BICEP_BIN` with `node infra/azure/validate.mjs` for credential-free IaC checks.

Inspect current GitHub Actions outcomes. Earlier `8d162e4`/`ffbad53` runs failed in the browser
composition after new UI routes were added without matching test mounts. Updated native mounts
and the final composition are published in `f7460ae`, whose independent rerun passed. Do not
report that green run as proof for future source changes. CI also emits nonblocking action-runtime
deprecation and upcoming runner-image migration notices; qualify action/runner upgrades separately.
Stage only verified owned files and publish each slice.
