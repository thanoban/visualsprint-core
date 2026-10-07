from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.orchestrator.scheduler as scheduler
from app.db.base import Base
from app.db.models import (
    BotSession,
    CalendarConnection,
    CalendarOccurrence,
    CalendarOccurrenceStatus,
    CaptureSession,
    Meeting,
    Org,
    PipelineJob,
)
from app.interfaces.calendar import CalendarEvent
from app.orchestrator.scheduler import sync_calendar_connection


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


class FakeCalendarAdapter:
    def __init__(self, events: list[CalendarEvent]) -> None:
        self._events = events
        self.calls = 0

    async def list_upcoming_events(self, connection, within):
        self.calls += 1
        return self._events


def _seed_org(
    db, join_policy: str = "all", capture_policy: str = "calendar"
) -> tuple[Org, CalendarConnection]:
    org = Org(name="Acme", join_policy=join_policy, capture_policy=capture_policy)
    db.add(org)
    db.flush()
    connection = CalendarConnection(
        org_id=org.id, provider="google", account_email="nimal@acme.com", secret_ref="ref"
    )
    db.add(connection)
    db.commit()
    return org, connection


def _event(
    event_id: str,
    *,
    conferencing_text: str = "https://acme.zoom.us/j/1234567890",
    is_organizer: bool = True,
    visibility: str = "default",
    start_offset_min: int = 60,
    duration_min: int = 30,
) -> CalendarEvent:
    start = datetime.now(UTC) + timedelta(minutes=start_offset_min)
    return CalendarEvent(
        external_event_id=event_id,
        title=f"Meeting {event_id}",
        start_at=start,
        end_at=start + timedelta(minutes=duration_min),
        organizer_email="nimal@acme.com",
        is_organizer=is_organizer,
        visibility=visibility,
        conferencing_text=conferencing_text,
    )


async def test_creates_meeting_session_and_scheduled_acquire_job(db):
    org, connection = _seed_org(db)
    event = _event("evt-1")
    adapter = FakeCalendarAdapter([event])

    created = await sync_calendar_connection(db, connection, adapter)

    assert len(created) == 1
    meeting = db.query(Meeting).filter(Meeting.external_calendar_event_id == "evt-1").one()
    assert meeting.platform == "zoom"
    assert meeting.platform_meeting_id == "1234567890"
    # SQLite (this test's in-memory DB) drops tzinfo on round-trip; Postgres
    # (production, DateTime(timezone=True)) does not -- compare naive.
    assert meeting.scheduled_start.replace(tzinfo=None) == event.start_at.replace(tzinfo=None)
    assert meeting.scheduled_end.replace(tzinfo=None) == event.end_at.replace(tzinfo=None)

    session = db.query(CaptureSession).filter(CaptureSession.meeting_id == meeting.id).one()
    assert session.id == created[0]
    assert session.mode == "A2"

    job = db.query(PipelineJob).filter(PipelineJob.capture_session_id == session.id).one()
    assert job.stage == "acquire"
    # Scheduled after the meeting ends + the processing-delay grace period,
    # never immediately -- Mode A2 has nothing to fetch until the platform
    # has finished processing the recording. (Naive comparison: see the
    # scheduled_start/end comment above -- same SQLite round-trip quirk.)
    run_at = job.run_at.replace(tzinfo=None)
    end_at = event.end_at.replace(tzinfo=None)
    assert run_at > end_at
    assert run_at == end_at + timedelta(minutes=10)


async def test_skips_events_with_no_conferencing_link(db):
    org, connection = _seed_org(db)
    adapter = FakeCalendarAdapter([_event("evt-1", conferencing_text="Just a plain status update")])

    created = await sync_calendar_connection(db, connection, adapter)

    assert created == []
    assert db.query(Meeting).count() == 0


async def test_organized_only_policy_skips_non_organizer_events(db):
    org, connection = _seed_org(db, join_policy="organized_only")
    adapter = FakeCalendarAdapter(
        [
            _event("evt-organizer", is_organizer=True),
            _event("evt-attendee", is_organizer=False),
        ]
    )

    created = await sync_calendar_connection(db, connection, adapter)

    assert len(created) == 1
    remaining = db.query(Meeting).one()
    assert remaining.external_calendar_event_id == "evt-organizer"


async def test_never_private_policy_skips_private_events(db):
    org, connection = _seed_org(db, join_policy="never_private")
    adapter = FakeCalendarAdapter(
        [
            _event("evt-public", visibility="default"),
            _event("evt-private", visibility="private"),
        ]
    )

    created = await sync_calendar_connection(db, connection, adapter)

    assert len(created) == 1
    remaining = db.query(Meeting).one()
    assert remaining.external_calendar_event_id == "evt-public"


async def test_all_policy_captures_everything_regardless_of_organizer_or_visibility(db):
    org, connection = _seed_org(db, join_policy="all")
    adapter = FakeCalendarAdapter(
        [
            _event("evt-1", is_organizer=False, visibility="private"),
        ]
    )

    created = await sync_calendar_connection(db, connection, adapter)

    assert len(created) == 1


async def test_sync_is_idempotent_on_repeated_calls(db):
    org, connection = _seed_org(db)
    adapter = FakeCalendarAdapter([_event("evt-1")])

    first = await sync_calendar_connection(db, connection, adapter)
    second = await sync_calendar_connection(db, connection, adapter)

    assert len(first) == 1
    assert second == []  # already scheduled -- not recreated
    assert db.query(Meeting).count() == 1
    assert db.query(CaptureSession).count() == 1
    assert db.query(PipelineJob).count() == 1


async def test_meet_event_uses_official_artifact_path_by_default(db):
    org, connection = _seed_org(db)
    adapter = FakeCalendarAdapter(
        [_event("evt-meet", conferencing_text="https://meet.google.com/abc-defg-hij")]
    )

    await sync_calendar_connection(db, connection, adapter)

    meeting = db.query(Meeting).one()
    session = db.query(CaptureSession).one()
    assert meeting.platform == "meet"
    assert session.mode == "A2"
    assert db.query(BotSession).count() == 0


async def test_meet_event_schedules_guest_bot_after_explicit_org_opt_in(db, monkeypatch):
    monkeypatch.setattr(
        scheduler, "get_settings", lambda: SimpleNamespace(
            bot_google_guest_enabled=True, bot_dispatch_enabled=True, bot_teams_guest_enabled=False
        )
    )
    org, connection = _seed_org(db)
    adapter = FakeCalendarAdapter(
        [_event("evt-meet", conferencing_text="https://meet.google.com/abc-defg-hij")]
    )

    await sync_calendar_connection(db, connection, adapter)

    bot = db.query(BotSession).one()
    assert bot.platform == "meet"
    assert bot.join_url == "https://meet.google.com/abc-defg-hij"


async def test_teams_event_also_schedules_a_bot_session_with_the_full_join_url(db, monkeypatch):
    monkeypatch.setattr(scheduler, "get_settings", lambda: SimpleNamespace(
        bot_google_guest_enabled=False, bot_dispatch_enabled=True, bot_teams_guest_enabled=True
    ))
    org, connection = _seed_org(db)
    join_url = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"
    adapter = FakeCalendarAdapter([_event("evt-teams", conferencing_text=join_url)])

    await sync_calendar_connection(db, connection, adapter)

    bot = db.query(BotSession).one()
    assert bot.platform == "teams"
    assert bot.join_url == join_url


async def test_zoom_event_does_not_schedule_a_bot_session(db):
    """Zoom's primary live path is RTMS (Mode A1, dispatched via the webhook,
    not the scheduler) -- a web bot is a fallback that must be requested
    explicitly, not launched for every Zoom calendar event."""
    org, connection = _seed_org(db)
    adapter = FakeCalendarAdapter([_event("evt-zoom")])  # default conferencing_text is a zoom link

    await sync_calendar_connection(db, connection, adapter)

    assert db.query(BotSession).count() == 0


async def test_raises_clearly_when_org_not_found(db):
    connection = CalendarConnection(
        org_id="does-not-exist", provider="google", account_email="x@acme.com", secret_ref="ref"
    )
    adapter = FakeCalendarAdapter([])

    with pytest.raises(RuntimeError, match="org does-not-exist not found"):
        await sync_calendar_connection(db, connection, adapter)


# F03: CalendarOccurrence tests

async def test_occurrence_row_is_created_on_first_sync(db):
    org, connection = _seed_org(db)
    event = _event("evt-1")
    await sync_calendar_connection(db, connection, FakeCalendarAdapter([event]))

    occ = db.query(CalendarOccurrence).one()
    assert occ.provider_event_id == "evt-1"
    assert occ.revision == 1
    assert occ.status == CalendarOccurrenceStatus.SCHEDULED
    assert occ.meeting_id is not None


async def test_duplicate_sync_does_not_create_second_occurrence(db):
    org, connection = _seed_org(db)
    event = _event("evt-1")
    adapter = FakeCalendarAdapter([event])
    await sync_calendar_connection(db, connection, adapter)
    await sync_calendar_connection(db, connection, adapter)
    assert db.query(CalendarOccurrence).count() == 1
    assert db.query(Meeting).count() == 1


async def test_reschedule_increments_revision_without_creating_new_occurrence(db):
    org, connection = _seed_org(db)
    event = _event("evt-1", start_offset_min=60)
    await sync_calendar_connection(db, connection, FakeCalendarAdapter([event]))

    rescheduled = _event("evt-1", start_offset_min=120)
    await sync_calendar_connection(db, connection, FakeCalendarAdapter([rescheduled]))

    assert db.query(CalendarOccurrence).count() == 1
    occ = db.query(CalendarOccurrence).one()
    assert occ.revision == 2
    assert occ.start_time.replace(tzinfo=None) == rescheduled.start_at.replace(tzinfo=None)
    assert db.query(Meeting).count() == 1


async def test_capture_policy_off_suppresses_meeting_creation(db):
    org, connection = _seed_org(db, capture_policy="off")
    await sync_calendar_connection(db, connection, FakeCalendarAdapter([_event("evt-1")]))
    assert db.query(CalendarOccurrence).count() == 1
    assert db.query(Meeting).count() == 0
    assert db.query(CaptureSession).count() == 0


async def test_per_event_override_on_enables_capture_even_with_manual_policy(db):
    org, connection = _seed_org(db, capture_policy="manual")
    event = _event("evt-1")
    await sync_calendar_connection(db, connection, FakeCalendarAdapter([event]))

    # Policy is "manual" and no override → occurrence exists but no meeting
    assert db.query(CalendarOccurrence).count() == 1
    assert db.query(Meeting).count() == 0

    # Set per-event override to "on" → next sync should create the meeting
    occ = db.query(CalendarOccurrence).one()
    occ.capture_override = "on"
    db.commit()

    await sync_calendar_connection(db, connection, FakeCalendarAdapter([event]))
    db.refresh(occ)
    assert occ.meeting_id is not None
    assert db.query(Meeting).count() == 1


async def test_per_event_override_off_suppresses_capture_when_policy_is_calendar(db):
    org, connection = _seed_org(db, capture_policy="calendar")
    event = _event("evt-1")

    # Pre-create the occurrence with capture_override="off" before first sync
    occ = CalendarOccurrence(
        org_id=org.id,
        connection_id=connection.id,
        provider_event_id="evt-1",
        original_start=event.start_at,
        start_time=event.start_at,
        end_time=event.end_at,
        title="Meeting evt-1",
        status=CalendarOccurrenceStatus.SCHEDULED,
        capture_override="off",
    )
    db.add(occ)
    db.commit()

    await sync_calendar_connection(db, connection, FakeCalendarAdapter([event]))
    db.refresh(occ)
    assert occ.meeting_id is None
    assert db.query(Meeting).count() == 0


async def test_cancelled_event_marks_occurrence_cancelled_on_next_sync(db):
    """When an event disappears from the calendar (deleted/declined), the
    scheduler marks the existing SCHEDULED occurrence as CANCELLED and does
    not create a Meeting for it."""
    org, connection = _seed_org(db)
    event = _event("evt-1")
    await sync_calendar_connection(db, connection, FakeCalendarAdapter([event]))

    occ = db.query(CalendarOccurrence).one()
    assert occ.status == CalendarOccurrenceStatus.SCHEDULED
    assert occ.meeting_id is not None

    # Event no longer appears in adapter response (deleted/declined)
    await sync_calendar_connection(db, connection, FakeCalendarAdapter([]))

    db.refresh(occ)
    assert occ.status == CalendarOccurrenceStatus.CANCELLED
    # Meeting already created is not deleted — just no new ones
    assert db.query(Meeting).count() == 1


async def test_cancelled_event_without_meeting_leaves_no_meeting(db):
    """An occurrence that was never scheduled for capture (policy=off) and
    then the event is cancelled — occurrence is marked CANCELLED, still no meeting."""
    org, connection = _seed_org(db, capture_policy="off")
    event = _event("evt-1")
    await sync_calendar_connection(db, connection, FakeCalendarAdapter([event]))

    occ = db.query(CalendarOccurrence).one()
    assert occ.meeting_id is None

    await sync_calendar_connection(db, connection, FakeCalendarAdapter([]))

    db.refresh(occ)
    assert occ.status == CalendarOccurrenceStatus.CANCELLED
    assert db.query(Meeting).count() == 0


async def test_dst_boundary_times_are_passed_through_from_adapter(db):
    """The scheduler passes CalendarEvent datetimes to the DB unchanged —
    timezone normalization to UTC is the responsibility of the CalendarAdapter
    (e.g. Google Calendar adapter always returns UTC-aware datetimes from its
    API). In PostgreSQL (production) DateTime(timezone=True) stores UTC;
    SQLite (test environment) strips tzinfo and stores the naive value as-is.
    This test verifies the scheduler does not silently alter the adapter's time."""
    import zoneinfo

    org, connection = _seed_org(db)
    tz = zoneinfo.ZoneInfo("America/New_York")
    # Post-DST spring-forward: 2025-03-09 03:30 ET = UTC-4 (deterministic offset)
    local_start = datetime(2025, 3, 9, 3, 30, 0, tzinfo=tz)

    event = CalendarEvent(
        external_event_id="evt-dst",
        title="DST test meeting",
        start_at=local_start,
        end_at=local_start + timedelta(hours=1),
        conferencing_text="https://acme.zoom.us/j/1234567890",
    )
    await sync_calendar_connection(db, connection, FakeCalendarAdapter([event]))

    occ = db.query(CalendarOccurrence).one()
    # SQLite drops tzinfo on round-trip and stores naive local time.
    # PostgreSQL (production) stores UTC-normalized time. Compare naive.
    stored_naive = occ.start_time.replace(tzinfo=None)
    adapter_naive = local_start.replace(tzinfo=None)
    assert stored_naive == adapter_naive, (
        "Scheduler must not alter the adapter's datetime; "
        "the adapter is responsible for returning UTC-normalized times"
    )
