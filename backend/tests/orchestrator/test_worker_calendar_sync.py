"""Worker-level periodic calendar sync (app/orchestrator/worker.py's
_sync_all_calendars). scheduler.py's own sync_calendar_connection logic is
already covered by tests/orchestrator/test_scheduler.py -- this proves the
periodic *caller* worker.py adds on top: registry construction, per-
connection isolation, and unknown-provider handling."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import create_engine, select
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


async def test_google_connection_gets_a_real_per_connection_oauth_token_provider(db, monkeypatch):
    """Without the _calendar_adapters test-injection override set, a google
    connection must build a real OAuthTokenProvider bound to ITS OWN
    secret_ref -- not a single shared instance every org's connection
    would otherwise collide on."""
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    connection = _connection(db, org, "google")

    monkeypatch.setenv("VS_GOOGLE_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("VS_GOOGLE_OAUTH_CLIENT_SECRET", "csecret")
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        adapter = worker._get_calendar_adapter_for_connection(db, connection)
    finally:
        get_settings.cache_clear()

    from app.adapters.calendar_google import GoogleCalendarAdapter
    from app.capture.oauth_token_provider import OAuthTokenProvider

    assert isinstance(adapter, GoogleCalendarAdapter)
    assert isinstance(adapter._tokens, OAuthTokenProvider)
    assert adapter._tokens._secret_ref == connection.secret_ref


async def test_microsoft_connection_gets_a_real_per_connection_oauth_token_provider(db, monkeypatch):
    """Same fix as google's -- microsoft is no longer a permanent stub."""
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    connection = _connection(db, org, "microsoft")

    monkeypatch.setenv("VS_MICROSOFT_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("VS_MICROSOFT_OAUTH_CLIENT_SECRET", "csecret")
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        adapter = worker._get_calendar_adapter_for_connection(db, connection)
    finally:
        get_settings.cache_clear()

    from app.adapters.calendar_microsoft import MicrosoftCalendarAdapter
    from app.capture.oauth_token_provider import OAuthTokenProvider

    assert isinstance(adapter, MicrosoftCalendarAdapter)
    assert isinstance(adapter._tokens, OAuthTokenProvider)
    assert adapter._tokens._secret_ref == connection.secret_ref


async def test_a_microsoft_connection_with_no_oauth_app_configured_is_skipped_not_fatal(db, monkeypatch):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    _connection(db, org, "microsoft")

    monkeypatch.delenv("VS_MICROSOFT_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("VS_MICROSOFT_OAUTH_CLIENT_SECRET", raising=False)
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        await worker._sync_all_calendars(db)  # must not raise
    finally:
        get_settings.cache_clear()


async def test_a_google_connection_with_no_oauth_app_configured_is_skipped_not_fatal(db, monkeypatch):
    """Real deployments may have Google OAuth unconfigured for a while
    after a connection already exists (e.g. mid-setup) -- that must not
    crash the sweep for every other org's connections."""
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    _connection(db, org, "google")

    monkeypatch.delenv("VS_GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("VS_GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        await worker._sync_all_calendars(db)  # must not raise
    finally:
        get_settings.cache_clear()


async def test_oauth_400_from_token_endpoint_prunes_connection(db):
    """A revoked/expired refresh token surfaces as HTTP 400 from the OAuth
    token endpoint. Google (and Microsoft) return 400, not 401, for this case.
    The connection must be pruned so the sweep stops hammering it every 6 min.
    A 400 from the Calendar API itself (different URL) must NOT prune the
    connection, so _is_oauth_token_url discrimination matters."""
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    conn = _connection(db, org, "google")
    conn_id = conn.id

    # Simulate httpx.HTTPStatusError from oauth2.googleapis.com/token
    fake_response = httpx.Response(400, request=httpx.Request("POST", "https://oauth2.googleapis.com/token"))
    oauth_400 = httpx.HTTPStatusError(
        "400 Bad Request", request=fake_response.request, response=fake_response
    )

    class FailsWith400Adapter:
        async def list_upcoming_events(self, connection, within):
            raise oauth_400

    worker._calendar_adapters = {"google": FailsWith400Adapter(), "microsoft": FakeCalendarAdapter()}

    await worker._sync_all_calendars(db)

    # Connection must be pruned — it is permanently unusable
    remaining = db.execute(select(CalendarConnection).where(CalendarConnection.id == conn_id)).scalar_one_or_none()
    assert remaining is None, "revoked-token connection must be pruned, not left to retry forever"


async def test_oauth_400_from_calendar_api_does_not_prune_connection(db):
    """A 400 from the Calendar API itself (bad query, quota) is transient and
    must NOT prune the connection — only OAuth token endpoint 400s are permanent."""
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    conn = _connection(db, org, "google")
    conn_id = conn.id

    # Simulate httpx.HTTPStatusError from the Calendar API (NOT the token endpoint)
    fake_response = httpx.Response(400, request=httpx.Request("GET", "https://www.googleapis.com/calendar/v3/calendars/primary/events"))
    calendar_400 = httpx.HTTPStatusError(
        "400 Bad Request", request=fake_response.request, response=fake_response
    )

    class FailsWithCalendar400Adapter:
        async def list_upcoming_events(self, connection, within):
            raise calendar_400

    worker._calendar_adapters = {"google": FailsWithCalendar400Adapter(), "microsoft": FakeCalendarAdapter()}

    await worker._sync_all_calendars(db)

    # Connection must NOT be pruned — Calendar API 400 is transient
    remaining = db.execute(select(CalendarConnection).where(CalendarConnection.id == conn_id)).scalar_one_or_none()
    assert remaining is not None, "Calendar API 400 must not prune the connection"
