"""Calendar-driven scheduling — discovers meetings without a human uploading
anything (docs/PROJECT_PLAN.md Phase 1: "Calendar watch, disclosure, coverage
telemetry"). Deterministic software owns this decision, per CLAUDE.md rule 1:
a `CalendarAdapter` only reports facts about events; every decision about
whether to capture one lives here, not in the adapter.

`sync_calendar_connection` is the unit a periodic job calls once per
`CalendarConnection` -- app/orchestrator/worker.py::_sync_all_calendars is
that periodic caller, wired into the worker's poll loop on
`VS_CALENDAR_SYNC_INTERVAL_S` (default 300s), same maturity level as
every other OAuth-backed integration in this codebase: real per-org
tokens once a customer connects, credential-blocked (loud, specific
failure) until they do.
"""

from datetime import timedelta

import structlog
from sqlalchemy.orm import Session

from app.adapters.calendar_common import detect_conferencing
from app.db.models import CalendarConnection, CaptureSession, Meeting, Org
from app.interfaces.calendar import CalendarAdapter
from app.orchestrator.queue import enqueue_pipeline

log = structlog.get_logger()

DEFAULT_SYNC_WINDOW = timedelta(hours=24)
# Grace period after a meeting ends before Mode A2's `acquire` stage first
# tries to fetch the recording/transcript -- the platform needs time to
# finish processing it. Retried automatically on failure regardless
# (queue.fail_job's exponential backoff), so this is a reasonable first
# attempt time, not a hard requirement.
DEFAULT_PROCESSING_DELAY = timedelta(minutes=10)


def _passes_join_policy(org: Org, event) -> bool:
    if org.join_policy == "organized_only":
        return event.is_organizer
    if org.join_policy == "never_private":
        return event.visibility != "private"
    return True  # "all" (or any unrecognized value -- fail open, not silently drop meetings)


async def sync_calendar_connection(
    db: Session,
    connection: CalendarConnection,
    adapter: CalendarAdapter,
    *,
    within: timedelta = DEFAULT_SYNC_WINDOW,
    processing_delay: timedelta = DEFAULT_PROCESSING_DELAY,
) -> list[str]:
    """Poll one calendar connection; create Meeting + CaptureSession(mode=A2)
    + a scheduled `acquire` PipelineJob for qualifying upcoming events that
    don't already have one. Idempotent on `Meeting.external_calendar_event_id`
    — safe to call repeatedly (e.g. every few minutes) without duplicating
    sessions for the same event. Returns created capture_session ids."""
    org = db.get(Org, connection.org_id)
    if org is None:
        raise RuntimeError(f"org {connection.org_id} not found for calendar_connection {connection.id}")

    events = await adapter.list_upcoming_events(connection, within)
    created_session_ids: list[str] = []

    for event in events:
        conferencing = detect_conferencing(event.conferencing_text)
        if conferencing is None:
            continue  # no platform to capture from -- not every calendar event is a video call
        platform, platform_meeting_id = conferencing

        if not _passes_join_policy(org, event):
            log.info(
                "scheduler.skipped_by_join_policy",
                org=org.id,
                calendar_event_id=event.external_event_id,
                join_policy=org.join_policy,
            )
            continue

        existing = (
            db.query(Meeting)
            .filter(
                Meeting.org_id == org.id,
                Meeting.external_calendar_event_id == event.external_event_id,
            )
            .one_or_none()
        )
        if existing is not None:
            continue  # already scheduled on a prior sync

        meeting = Meeting(
            org_id=org.id,
            title=event.title,
            platform=platform,
            platform_meeting_id=platform_meeting_id,
            external_calendar_event_id=event.external_event_id,
            scheduled_start=event.start_at,
            scheduled_end=event.end_at,
        )
        db.add(meeting)
        db.flush()

        session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="A2")
        db.add(session)
        db.flush()

        enqueue_pipeline(db, org.id, session.id, run_at=event.end_at + processing_delay)
        created_session_ids.append(session.id)
        log.info(
            "scheduler.session_created",
            org=org.id,
            meeting=meeting.id,
            session=session.id,
            platform=platform,
            run_at=(event.end_at + processing_delay).isoformat(),
        )

    db.commit()
    return created_session_ids
