from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import BotSession, BotStatus, CalendarConnection, CaptureSession, Meeting, Org, PipelineJob
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


def _seed_org(db, join_policy: str = "all") -> tuple[Org, CalendarConnection]:
    org = Org(name="Acme", join_policy=join_policy)
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


async def test_meet_event_also_schedules_a_bot_session(db):
    """Meet is Mode B primary (no recording permission needed) alongside the
    A2 session -- docs/03-capture.md's architecture pivot for orgs that
    can't/won't grant platform recording access."""
    org, connection = _seed_org(db)
    adapter = FakeCalendarAdapter(
        [_event("evt-meet", conferencing_text="https://meet.google.com/abc-defg-hij")]
    )

    await sync_calendar_connection(db, connection, adapter)

    bot = db.query(BotSession).one()
    meeting = db.query(Meeting).one()
    assert bot.meeting_id == meeting.id
    assert bot.platform == "meet"
    assert bot.join_url == "https://meet.google.com/abc-defg-hij"
    assert bot.status == BotStatus.SCHEDULED
    assert bot.scheduled_start.replace(tzinfo=None) == meeting.scheduled_start.replace(tzinfo=None)


async def test_teams_event_also_schedules_a_bot_session_with_the_full_join_url(db):
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
