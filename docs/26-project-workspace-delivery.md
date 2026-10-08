# Project-organized meetings — delivery and continuation

Date: 2026-10-08. This is an incremental implementation record, not a production-readiness claim.
The current founder architecture and feature contracts in documents 18 and 20–24 remain authoritative.

## Implemented in this slice

- `/projects`: create private projects, optionally linked to a customer, and open accessible projects.
- `/projects/{id}`: project-specific meeting history, processing/report links, evidence-backed current
  memory, rename/archive controls and explicit membership management for project owners.
- `/customers`: create customers and open their history; customer detail aggregates only meetings
  from projects that the signed-in user can access, never every project owned by that customer.
- `/unassigned`: the meeting owner's private inbox. Historical meetings without an owner are not
  silently assigned an owner or exposed through this inbox.
- New manual uploads, companion sessions and explicitly enabled legacy instant-bot requests now
  record the authenticated creator as meeting owner, so new meetings can enter that inbox and be
  assigned. This is ownership of the data, not attribution of any recorded voice to that user.
- Assign/move/unassign controls with an explicit sharing warning and assignment version checks.
  The meeting owner needs source and target project edit access. A stale version returns 409; the
  client does not automatically retry a sharing mutation. Archived projects reject new assignments.
- Project members are selected from existing workspace members, not guessed from meeting attendees.
  Removed workspace members are excluded from the project roster. Last-owner removal protection
  remains enforced by the existing membership API.
- Workspace-authenticated relative API calls use the existing configured API origin. No OAuth URL
  or production-origin change is needed. Loading, empty, permission and mutation errors are visible.

New history endpoints:

```text
GET /api/v2/workspaces/{org_id}/meetings
GET /api/v2/workspaces/{org_id}/meetings/{meeting_id}
GET /api/v2/workspaces/{org_id}/projects/{project_id}
GET /api/v2/workspaces/{org_id}/projects/{project_id}/members
```

History accepts one of `project_id`, `customer_id`, or `unassigned=true`, with `limit` (1–100,
default 25) and a cursor. Authorization is applied before pagination. Ordering uses creation time
plus meeting ID, so tied timestamps do not drop or duplicate meetings between pages. Capture and
processing states come from persisted records, not a fabricated “capturing” banner.

New query logic lives in `backend/app/modules/projects`, not in a second router importing another
router's policies. The UI is split into typed API, scoped data hook, meeting history, current memory
and settings components. Scope and user changes do not reuse another identity's cached response;
window focus revalidates reads. Assignment uses a native modal dialog for keyboard focus/Escape.

## Verification

- PostgreSQL/pgvector targeted API suites initially passed **60 tests**; the expanded final gate
  passed **77 tests**, no skips, covering founder privacy/freshness, projects/assignments, current
  memory and the affected legacy capture/companion endpoints. New cases cover private pagination,
  owner-only inbox, removed-member roster, source-viewer moves, tied cursors, stale assignment
  conflicts, and all three owned manual-intake paths. Existing concurrency regressions also ran.
- Migrated isolated PostgreSQL upload-pipeline suite: **8 passed**. The earlier migrations applied
  from an empty database through `i0c1d2e3f4a5`; mock ASR/vision tests preserve upload, transcript,
  speaker-uncertainty and legacy screen-stage behavior with the new authenticated ownership.
- Frontend client-contract tests: **6 passed**. ESLint, TypeScript and the Next.js production build
  passed; the build includes `/projects`, `/projects/[id]`, `/customers`, `/customers/[id]` and
  `/unassigned`. No authenticated browser E2E or live provider test was performed.
- Backend Ruff and scoped strict mypy passed (five source files). The repository mypy gate passed
  at the pre-existing **216-error whole-app baseline**; this is not a whole-app strict clean bill.
- No migration is required by this slice. The earlier audit migrations remain separate.
- One subsequent frontend build compiled but its Windows TypeScript worker exited with code
  3221226505. The same build command succeeded on retry. Standalone TypeScript checks also passed;
  the transient process exit is not being hidden as a passing initial attempt.

Tests used isolated local databases and mocked external providers, not real customer meetings.
The initial PostgreSQL attempt failed at fixture setup while the retained audit container recovered
from an interrupted shutdown. The successful run used a fresh disposable `visualsprint-project-gate-20261008`
container on loopback port 55434, not the application database. Disk synchronization was disabled
only for this disposable gate; these tests do not prove crash durability. The container is retained
and stopped after verification. The older audit container is also retained and stopped.

## Still unfinished — next slices

1. Calendar → v2 capture: connection ownership, occurrence scheduling/cancellation, no duplicate
   legacy/v2 transports, durable admission/end-state reconciliation and the capture UI.
2. Saved project/customer/meeting chats: leased answer generation, permission recheck after model
   work, validated revision-bound citations, bounded history and saved-thread UI. The current API
   intent alone does not mean answers are generated.
3. Export/deletion: durable execution, source-scoped download authorization, immediate deletion
   read gating, cascade/secret/provider cleanup and audit receipts.
4. Provider qualification: a consented real Meet/Zoom/Teams session, actual admission and text,
   meeting-end acknowledgement, final report, concurrency, outages and deletion-deadline evidence.

This slice does not create meetings automatically inside a chosen project, generate saved chat
answers, run export/deletion jobs, or prove live bot joining. Assignment updates are reflected in
current-memory reads; a durable downstream invalidation outbox is still a separate delivery gate.
Directory/member lists retain their existing bounded/unbounded contracts and need explicit scalable
pagination before large-workspace qualification. Browser interaction and production auth still
need end-to-end acceptance; client-contract tests and a build are not substitutes.

## Quick user check after running matching frontend/backend builds

1. Sign in; choose Projects and create a customer-linked or internal project.
2. Open Unassigned, select Assign / move, review the sharing warning and confirm the project.
3. Open that project. Its meeting history and current memory should contain the assigned meeting.
4. Create a second project and move the same meeting there. The first project's history should
   lose it. Unassigning should return it to the owner's inbox.
5. Add an existing workspace member as a viewer. They can read the project, but cannot move its
   meetings. A workspace owner without project membership must not see the private project.
6. Review the report/processing link. Only a completed processing record is labelled report-ready;
   no link proves that a bot successfully joined a real call.

Do not enable the production pilot from this slice's local results. No paid GCP resources, provider
subscriptions, production migration, deployment or production meeting capture are part of this work.
