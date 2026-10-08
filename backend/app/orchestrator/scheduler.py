"""Calendar-driven scheduling — discovers meetings without a human uploading
anything (docs/PROJECT_PLAN.md Phase 1: "Calendar watch, disclosure, coverage
telemetry"). Deterministic software owns this decision, per CLAUDE.md rule 1:
a `CalendarAdapter` only reports facts about events; every decision about
whether to capture one lives here, not in the adapter.

`sync_calendar_connection` is the unit a periodic job calls once per
`CalendarConnection` — app/orchestrator/worker.py::_sync_all_calendars is
that periodic caller, wired into the worker's poll loop on
`VS_CALENDAR_SYNC_INTERVAL_S` (default 300s), same maturity level as
every other OAuth-backed integration in this codebase: real per-org
tokens once a customer connects, credential-blocked (loud, specific
failure) until they do.
"""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import cast

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters.calendar_common import BOT_ELIGIBLE_PLATFORMS, bot_join_url, detect_conferencing
from app.config import get_settings
from app.db.models import (
    BotSession,
    BotStatus,
    CalendarConnection,
    CalendarOccurrence,
    CalendarOccurrenceStatus,
    CaptureSession,
    Meeting,
    Org,
)
from app.interfaces.calendar import CalendarAdapter, CalendarEvent
from app.interfaces.secretstore import SecretStore
from app.orchestrator.queue import enqueue_pipeline

log = structlog.get_logger()

DEFAULT_SYNC_WINDOW = timedelta(hours=24)
# Grace period after a meeting ends before Mode A2's `acquire` stage first
# tries to fetch the recording/transcript — the platform needs time to
# finish processing it. Retried automatically on failure regardless
# (queue.fail_job's exponential backoff), so this is a reasonable first
# attempt time, not a hard requirement.
DEFAULT_PROCESSING_DELAY = timedelta(minutes=10)


def _passes_join_policy(org: Org, event: CalendarEvent) -> bool:
    if org.join_policy == "organized_only":
        return bool(event.is_organizer)
    if org.join_policy == "never_private":
        return event.visibility != "private"
    return org.join_policy == "all"  # Unknown policy must not record private meetings.


def _capture_enabled(org: Org, occurrence: CalendarOccurrence) -> bool:
    """Return True when this occurrence should result in a CaptureSession.

    Per-event override wins; falls back to workspace capture_policy.
    An org with capture_policy='off' never captures even if an override is set,
    because the workspace owner has not acknowledged disclosure yet.
    """
    if org.capture_policy == "off":
        return False
    if occurrence.capture_override == "on":
        return True
    if occurrence.capture_override == "off":
        return False
    # null override: inherit workspace policy
    return org.capture_policy in {"calendar", "all"}


async def sync_calendar_connection(
    db: Session,
    connection: CalendarConnection,
    adapter: CalendarAdapter,
    *,
    within: timedelta = DEFAULT_SYNC_WINDOW,
    processing_delay: timedelta = DEFAULT_PROCESSING_DELAY,
    secret_store: SecretStore | None = None,
) -> list[str]:
    """Poll one calendar connection; upsert CalendarOccurrence rows, then
    create Meeting + CaptureSession(mode=A2) + a scheduled `acquire`
    PipelineJob for qualifying upcoming events that don't already have one.

    Idempotent on (connection_id, provider_event_id, original_start) —
    safe to call repeatedly without duplicating sessions. Handles reschedules
    by updating start/end and incrementing revision. Returns created
    capture_session ids."""
    org = db.get(Org, connection.org_id)
    if org is None:
        raise RuntimeError(
            f"org {connection.org_id} not found for calendar_connection {connection.id}"
        )

    events = await adapter.list_upcoming_events(connection, within)
    db.refresh(org)
    if org.pilot_features_enabled:
        from app.adapters.secretstore_gcp import get_secretstore
        from app.modules.calendars.durable_capture import sync_snapshot

        secrets = secret_store or cast(Callable[[], SecretStore], get_secretstore)()
        return await sync_snapshot(db, connection, events, secrets, within=within)
    created_session_ids: list[str] = []
    seen_provider_ids: set[str] = set()

    for event in events:
        seen_provider_ids.add(event.external_event_id)
        conferencing = detect_conferencing(event.conferencing_text)
        platform: str | None = None
        platform_meeting_id: str | None = None
        if conferencing is not None:
            platform, platform_meeting_id = conferencing

        if not _passes_join_policy(org, event):
            log.info(
                "scheduler.skipped_by_join_policy",
                org=org.id,
                calendar_event_id=event.external_event_id,
                join_policy=org.join_policy,
            )
            continue

        # --- Upsert CalendarOccurrence ---
        # Lookup by (connection_id, provider_event_id); original_start records
        # the first-seen start and is never changed after creation.
        occurrence = db.execute(
            select(CalendarOccurrence).where(
                CalendarOccurrence.connection_id == connection.id,
                CalendarOccurrence.provider_event_id == event.external_event_id,
            )
        ).scalar_one_or_none()

        if occurrence is None:
            occurrence = CalendarOccurrence(
                org_id=org.id,
                connection_id=connection.id,
                provider_event_id=event.external_event_id,
                original_start=event.start_at,
                start_time=event.start_at,
                end_time=event.end_at,
                title=event.title,
                platform=platform,
                platform_meeting_id=platform_meeting_id,
                status=CalendarOccurrenceStatus.SCHEDULED,
            )
            db.add(occurrence)
            db.flush()
        else:
            # A cancelled event can reappear in a later authoritative snapshot.
            occurrence.status = CalendarOccurrenceStatus.SCHEDULED
            # Detect reschedule: start or end changed
            rescheduled = (
                occurrence.start_time != event.start_at or occurrence.end_time != event.end_at
            )
            if rescheduled:
                occurrence.start_time = event.start_at
                occurrence.end_time = event.end_at
                occurrence.revision += 1
                occurrence.title = event.title
                occurrence.platform = platform
                occurrence.platform_meeting_id = platform_meeting_id
                log.info(
                    "scheduler.occurrence_rescheduled",
                    org=org.id,
                    occurrence=occurrence.id,
                    revision=occurrence.revision,
                )
            # Even if not rescheduled, update title in case it changed
            elif occurrence.title != event.title:
                occurrence.title = event.title

        # --- Skip capture for cancelled occurrences or when policy disables it ---
        if occurrence.status == CalendarOccurrenceStatus.CANCELLED:
            continue
        if not _capture_enabled(org, occurrence):
            continue
        if platform is None:
            continue

        # --- Create Meeting + CaptureSession if not already created ---
        if occurrence.meeting_id is not None:
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

        occurrence.meeting_id = meeting.id

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

        # Default Google Meet capture is official post-meeting artifacts (A2).
        # Scheduling an anonymous bot for every ordinary Meet invitation only
        # creates predictable guest-access failures. Guest bots require an
        # explicit organization-level opt-in for Open-access meetings.
        settings = get_settings()
        bot_enabled_for_platform = (
            settings.bot_dispatch_enabled
            and platform in BOT_ELIGIBLE_PLATFORMS
            and (
                (platform == "meet" and settings.bot_google_guest_enabled)
                or (platform == "teams" and settings.bot_teams_guest_enabled)
            )
        )
        if bot_enabled_for_platform and platform_meeting_id is not None:
            join_url = bot_join_url(platform, platform_meeting_id)
            if join_url:
                db.add(
                    BotSession(
                        org_id=org.id,
                        meeting_id=meeting.id,
                        platform=platform,
                        join_url=join_url,
                        status=BotStatus.SCHEDULED,
                        scheduled_start=event.start_at,
                    )
                )
                log.info(
                    "scheduler.bot_scheduled",
                    org=org.id,
                    meeting=meeting.id,
                    platform=platform,
                    scheduled_start=event.start_at.isoformat(),
                )

    # --- Mark occurrences as CANCELLED when the event is no longer returned ---
    # Google Calendar's list_upcoming_events only returns active events. If a
    # SCHEDULED occurrence is in our DB but not in this sync's results, the event
    # was deleted or declined — mark it CANCELLED so we don't create a Meeting for it.
    now = datetime.now(UTC)
    stale = (
        db.execute(
            select(CalendarOccurrence).where(
                CalendarOccurrence.connection_id == connection.id,
                CalendarOccurrence.status == CalendarOccurrenceStatus.SCHEDULED,
                CalendarOccurrence.start_time > now,
                CalendarOccurrence.start_time <= now + within,
                CalendarOccurrence.provider_event_id.not_in(seen_provider_ids),
            )
        )
        .scalars()
        .all()
    )
    for occ in stale:
        occ.status = CalendarOccurrenceStatus.CANCELLED
        log.info(
            "scheduler.occurrence_cancelled",
            org=org.id,
            occurrence=occ.id,
            provider_event_id=occ.provider_event_id,
        )

    db.commit()
    return created_session_ids
