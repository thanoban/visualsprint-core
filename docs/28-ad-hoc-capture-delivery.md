# Calendar-independent capture: plan and delivery

Updated 2026-10-08. This extends F03–F06 of the [current feature plan](21-feature-delivery-plan.md).
It is an implementation checkpoint, not proof of deployment or successful live meeting admission.

## Requirement and intended experience

A founder can capture a customer call even if it is absent from every connected calendar. Calendar
OAuth, a synchronized event and an occurrence row are not prerequisites for manual capture.

1. Open **Capture now** (`/capture`); the same form is available on Upload, Calendar and an editable
   project page. Paste the original Meet, Zoom or Teams invitation URL, including its passcode query.
2. Optionally name the call and choose an active project where you are an owner/editor. Default is
   **Unassigned, private to the meeting owner**. Assigning shares transcript/summary with project members.
3. Acknowledge disclosure and enable manual capture through onboarding if not already configured.
   Tell participants about transcription. An operator must configure the capture provider and its STT.
4. Click Capture now. The server persists an owned meeting, optional assignment, usage reservation
   and dispatch outbox atomically. HTTP acceptance means queued intent, not successful capture.
5. An independent worker dispatches and reconciles provider joining/admission/capture. The host may
   need to admit the visible notetaker. Private/authenticated-only rooms can still refuse it; no bypass.
6. Follow status and transcript freshness. Reopen the opaque request link after a page refresh, or
   select it from your recent captures or meeting history. No invitation secrets go in this status URL.
7. Stop early using Stop capture, or let the provider report meeting end. An acknowledged stop is not
   confirmed departure. The existing four-hour safety cap remains; calendar end is not a stop trigger.
8. A finalized provider transcript enters the existing understand → verify → memory → report jobs.
   Capture completion and report readiness are separate. Open processing/report using the actual
   capture-session ID, not the meeting ID. Saved project/customer chats and memory use assigned history.

The server cannot discover an arbitrary call absent from calendars without a supplied link or another
approved detection integration. This flow supports **manual link intake**, not desktop auto-detection.

## Competitor benchmark, without assumed parity

Fathom explicitly distinguishes impromptu meetings from calendar-scheduled meetings. Its current
documentation also distinguishes new botless Zoom capture from older account-connected behavior.
That supports separating our intake modes; it does not establish that our server bot has Fathom's
desktop/botless capabilities. [Official Fathom impromptu-meeting documentation](https://help.fathom.video/en/articles/294208).

Current VisualSprint lane is English transcript-only. Video, screenshots, Slack Huddles, universal
Meet/Teams/Zoom admission and full Fathom parity are **not** delivered or qualified by this checkpoint.
Project/customer continuity, private saved chats and agendas remain our approved product direction.

## Corrections implemented

- Added `/capture` and sidebar entry with optional title/project, recovery links and recent request pages.
- Replaced Upload's conflicting legacy `/api/v1/.../capture/instant` UI with the shared durable v2 form.
  Historical file upload remains available; no recording-storage architecture was added here.
- Corrected the report link: a meeting ID is not a capture-session ID. Status now returns the exact
  request-linked session, processing state and readiness; it never selects an unrelated newest session.
  Saved-chat citation links now also use the cited item's scoped capture session, not its meeting ID.
- Added authenticated `GET /capture-requests`, default 25/max 100 with stable `(created_at, id)` cursors.
  Requester ownership and current meeting access filter SQL before limits. Invitation URLs, secret
  references, provider keys and passcodes are absent from responses. Cross-scope sessions are excluded.
- Added a manual-readiness flag independent of calendar connectivity and automatic scheduling policy.
- Retry keys now cover normalized URL, title and project, preventing silent sharing changes on retry.
- Sequential abortable status polling avoids overlapping requests, continues through processing and
  stops at terminal results. Removed access clears the capture display and stops polling.
- Fixed stop reconciliation: a provider terminal update confirms both requested and already
  acknowledged stops. Previously the second poll finalized capture but left departure unconfirmed.
- Under the existing workspace lock, a second manual key for the actor's same active native meeting
  conflicts. Idempotent retry returns the same resource. Future queued occurrences do not block an
  immediate call; terminal occurrences do not permanently blacklist reused links. Provider native-key
  leases remain the independent guard across actors/workspaces that share an upstream account.

## API / code map

| Boundary | Implementation |
|---|---|
| Intake | `backend/app/modules/capture/api.py`, `intake.py`; POST `/captures` + Idempotency-Key |
| Recovery / processing / stop | `backend/app/api/capture_v2.py`; GET collection/item, POST item/stop |
| Provider and final transcript | Existing `backend/app/capture/dispatcher.py`, `reconciler.py`, `transcript_bridge.py` |
| Shared form and typed client | `frontend/features/founder/CapturePanel.tsx`, `frontend/lib/founder-api.ts` |
| Hub and entry points | `frontend/app/capture/page.tsx`, Upload, Calendar, project page, MeetingHistory, sidebar |
| Regression coverage | `backend/tests/api/test_ad_hoc_capture.py`, existing API/capture suites; frontend client tests |

No schema migration is needed: this uses the existing request/session/outbox tables. Keep API and
frontend artifact versions aligned for the new readiness/status fields. Existing v1 endpoints remain;
they are not presented as the current manual capture UI.

## Verification and remaining gates

Verification on 2026-10-08:

- Initial PostgreSQL gate: **24 passed** across ad-hoc and calendar workflow tests.
- Broad `tests/api tests/capture` regression: **500 passed, 1 skipped**, 318 seconds. This run imported
  code before the final stop-confirmation/citation hardening; it is not substituted for the final delta.
- Final ad-hoc, saved-chat worker, threads and reconciler suites: **62 passed**, 38 seconds. Covers real
  PostgreSQL two-browser locking, privacy/revocation, session-scope guards and HTTP intent → mock provider
  dispatch → host end/user stop → final transcript ingestion → one analysis job. Analysis/model quality
  and browser E2E are not proven by this controlled-provider test.
- Client contracts: **9 passed**. Frontend lint, TypeScript and production build passed on the final
  code, including the new `/capture` route.
- Ruff passed; strict load-bearing modules are clean and whole-app mypy backlog remains **212**.

The existing Starlette/httpx deprecation and Node module-type warning remain non-failing tool warnings.
Tests use `visualsprint_project_test` and `visualsprint_delivery_delta`; the migrated pipeline database
is separate. Only the owned disposable PostgreSQL container was started and it is stopped afterward;
no application servers or continuous workers were started.

Tests use isolated PostgreSQL databases and mocked provider/calendar/model dependencies. They do not
prove real browser rendering, real STT quality, platform admission, latency or end-of-call detection.
Before pilot release run consented calls per [the live acceptance matrix](23-testing-and-operations.md),
including impromptu calls without calendar OAuth, refresh/API/worker restart, host denial, passcode
refusal, unknown dispatch, user stop, host end, long silence and a call exceeding its planned end.

Provider/STT, independent capture worker and analysis worker are still operational prerequisites;
calendar scheduler is optional for this manual path. Startup guidance is in [delivery 27](27-calendar-chat-and-data-rights-delivery.md).
No live bot, cloud provisioning, production migration, deployment, paid activation or OAuth URL change
has been performed. Publishing the feature branch does not by itself deploy or prove live capture.

Rollback: restore the previous application artifacts while leaving the additive stored requests intact.
Do not silently redirect pending v2 captures to legacy transports or POST again after uncertain dispatch.
