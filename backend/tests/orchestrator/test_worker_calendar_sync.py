"""Worker-level periodic calendar sync (app/orchestrator/worker.py's
_sync_all_calendars). scheduler.py's own sync_calendar_connection logic is
already covered by tests/orchestrator/test_scheduler.py -- this proves the
periodic *caller* worker.py adds on top: registry construction, per-
connection isolation, and unknown-provider handling."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.orchestrator.worker as worker
from app.db.base import Base
from app.db.models import CalendarConnection, Org
from app.interfaces.calendar import CalendarEvent


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


@pytest.fixture(autouse=True)
def _reset_calendar_adapters():
    yield
    worker._calendar_adapters = None


class FakeCalendarAdapter:
    def __init__(self, events: list[CalendarEvent] | None = None, *, raises: bool = False) -> None:
        self._events = events or []
        self._raises = raises
        self.calls = 0

    async def list_upcoming_events(self, connection, within):
        self.calls += 1
        if self._raises:
            raise RuntimeError("token expired")
        return self._events


def _connection(db, org, provider: str) -> CalendarConnection:
    conn = CalendarConnection(
        org_id=org.id, provider=provider, account_email=f"{provider}@acme.com", secret_ref="ref"
    )
    db.add(conn)
    db.commit()
    return conn


def _event(event_id: str) -> CalendarEvent:
    start = datetime.now(UTC) + timedelta(minutes=60)
    return CalendarEvent(
        external_event_id=event_id,
        title="Standup",
        start_at=start,
        end_at=start + timedelta(minutes=30),
        is_organizer=True,
        conferencing_text="https://acme.zoom.us/j/1234567890",
    )


async def test_syncs_every_connection_across_both_providers(db):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    google_conn = _connection(db, org, "google")
    ms_conn = _connection(db, org, "microsoft")

    google_adapter = FakeCalendarAdapter([_event("g1")])
    ms_adapter = FakeCalendarAdapter([_event("m1")])
    worker._calendar_adapters = {"google": google_adapter, "microsoft": ms_adapter}

    await worker._sync_all_calendars(db)

    assert google_adapter.calls == 1
    assert ms_adapter.calls == 1
    assert google_conn.id is not None and ms_conn.id is not None  # sanity: both rows real


async def test_one_connections_failure_does_not_block_the_others(db):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    _connection(db, org, "google")
    _connection(db, org, "microsoft")

    failing = FakeCalendarAdapter(raises=True)
    working = FakeCalendarAdapter([_event("m1")])
    worker._calendar_adapters = {"google": failing, "microsoft": working}

    await worker._sync_all_calendars(db)  # must not raise

    assert failing.calls == 1
    assert working.calls == 1


async def test_unknown_provider_is_skipped_not_fatal(db):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    _connection(db, org, "some_future_provider")
    worker._calendar_adapters = {"google": FakeCalendarAdapter(), "microsoft": FakeCalendarAdapter()}

    await worker._sync_all_calendars(db)  # must not raise, no adapter matches


async def test_get_calendar_adapters_covers_google_and_microsoft():
    adapters = worker._get_calendar_adapters()
    assert set(adapters.keys()) == {"google", "microsoft"}
