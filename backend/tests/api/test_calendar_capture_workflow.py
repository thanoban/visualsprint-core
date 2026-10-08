"""Calendar and manual intake exercise the real durable request/outbox boundary."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.auth import dependency as auth
from app.capture.dispatcher import dispatch_next
from app.db.models import (
    BotSession,
    CalendarConnection,
    CalendarOccurrence,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureSession,
    CaptureStopState,
    Meeting,
    Org,
    OrgMember,
    OutboxEvent,
    Project,
    ProjectMember,
    ProviderBinding,
    UsageReservation,
    UsageReservationStatus,
    User,
)
from app.interfaces.calendar import CalendarEvent
from app.interfaces.capture_provider import CaptureReference, CaptureSnapshot, CaptureStatus
from app.main import app
from app.modules.capture.api import secrets
from app.oauth.flow import sign_state, verify_state_actor
from app.orchestrator.scheduler import sync_calendar_connection

ACTOR = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


class Secrets:
    def __init__(self):
        self.values = {}

    async def put(self, name, value):
        self.values[name] = value

    async def get(self, name):
        return self.values[name]

    async def delete(self, name):
        self.values.pop(name, None)


class Calendar:
    def __init__(self, events):
        self.events = events

    async def list_upcoming_events(self, connection, within):
        return self.events


@pytest.fixture
def setup(db_session):
    db = db_session
    org = Org(
        name="Calendar pilot",
        pilot_features_enabled=True,
        capture_policy="calendar",
        join_policy="all",
        disclosure_ack_at=datetime.now(UTC),
    )
    db.add(org)
    db.flush()
    for identifier in [ACTOR, OTHER]:
        db.add(User(id=identifier, email=f"{identifier}@example.com"))
    db.flush()
    db.add_all(
        [
            OrgMember(org_id=org.id, user_id=ACTOR, role="owner"),
            OrgMember(org_id=org.id, user_id=OTHER, role="member"),
        ]
    )
    connection = CalendarConnection(
        org_id=org.id,
        owner_user_id=ACTOR,
        provider="google",
        account_email="owner@example.com",
        secret_ref="test/oauth",
    )
    db.add(connection)
    db.commit()
    return org, connection, Secrets()


def event(key="first", start=None, url="https://meet.google.com/abc-defg-hij"):
    start = start or datetime.now(UTC) + timedelta(hours=1)
    return CalendarEvent(
        external_event_id=key,
        title="Private customer call",
        start_at=start,
        end_at=start + timedelta(minutes=30),
        conferencing_text=url,
        is_organizer=True,
    )


@pytest.mark.asyncio
async def test_calendar_persists_owned_scheduled_capture_only_once(db_session, setup):
    org, connection, store = setup
    occurrence_event = event()
    calendar = Calendar([occurrence_event])
    created = await sync_calendar_connection(db_session, connection, calendar, secret_store=store)
    assert len(created) == 1
    assert (
        await sync_calendar_connection(db_session, connection, calendar, secret_store=store) == []
    )
    request = db_session.get(CaptureRequest, created[0])
    meeting = db_session.get(Meeting, request.meeting_id)
    queued = db_session.scalar(
        select(OutboxEvent).where(OutboxEvent.operation == "capture.dispatch")
    )
    assert meeting.owner_user_id == request.requested_by == ACTOR
    assert queued.run_at.replace(tzinfo=UTC) == occurrence_event.start_at
    assert request.policy_snapshot["language"] == "en"
    assert store.values[request.meeting_url_secret_ref] == occurrence_event.conferencing_text
    assert db_session.scalar(select(func.count()).select_from(CaptureSession)) == 0
    assert db_session.scalar(select(func.count()).select_from(BotSession)) == 0
    assert db_session.scalar(select(func.count()).select_from(CalendarOccurrence)) == 1


@pytest.mark.asyncio
async def test_calendar_reschedule_cancels_old_intent_and_releases_reservation(db_session, setup):
    _, connection, store = setup
    original = event()
    first = (
        await sync_calendar_connection(
            db_session, connection, Calendar([original]), secret_store=store
        )
    )[0]
    moved = original.model_copy(
        update={
            "start_at": original.start_at + timedelta(hours=1),
            "end_at": original.end_at + timedelta(hours=1),
        }
    )
    second = (
        await sync_calendar_connection(
            db_session, connection, Calendar([moved]), secret_store=store
        )
    )[0]
    assert db_session.get(CaptureRequest, first).status == CaptureRequestStatus.CANCELLED
    assert (
        db_session.scalar(
            select(UsageReservation).where(UsageReservation.request_id == first)
        ).status
        == UsageReservationStatus.RELEASED
    )
    assert (
        db_session.get(CaptureRequest, second).meeting_id
        == db_session.get(CaptureRequest, first).meeting_id
    )
    assert db_session.scalar(select(func.count()).select_from(Meeting)) == 1
    await sync_calendar_connection(db_session, connection, Calendar([]), secret_store=store)
    assert db_session.get(CaptureRequest, second).status == CaptureRequestStatus.CANCELLED


@pytest.mark.asyncio
async def test_historical_unowned_calendar_cannot_capture_in_pilot(db_session, setup):
    _, connection, store = setup
    connection.owner_user_id = None
    db_session.commit()
    assert (
        await sync_calendar_connection(
            db_session, connection, Calendar([event()]), secret_store=store
        )
        == []
    )
    assert (
        db_session.scalar(select(CalendarOccurrence)).capture_error
        == "calendar_owner_reconnect_required"
    )
    assert db_session.scalar(select(func.count()).select_from(Meeting)) == 0


@pytest.mark.asyncio
async def test_monthly_limit_is_visible_and_does_not_create_dispatch(db_session, setup):
    org, connection, store = setup
    org.capture_monthly_minutes = 1
    db_session.commit()
    assert (
        await sync_calendar_connection(
            db_session, connection, Calendar([event()]), secret_store=store
        )
        == []
    )
    assert db_session.scalar(select(CalendarOccurrence)).capture_error == "capture_monthly_limit"
    assert db_session.scalar(select(func.count()).select_from(CaptureRequest)) == 0


@pytest.mark.asyncio
async def test_occurrence_access_override_conflict_and_disable(client, db_session, setup):
    org, connection, store = setup
    request_id = (
        await sync_calendar_connection(
            db_session, connection, Calendar([event()]), secret_store=store
        )
    )[0]
    occurrence = db_session.scalar(select(CalendarOccurrence))
    base = f"/api/v2/workspaces/{org.id}"
    app.dependency_overrides[auth.get_current_user] = lambda: User(
        id=OTHER, email="other@example.com"
    )
    assert client.get(f"{base}/occurrences").json() == []
    assert client.get(f"{base}/connections").json() == []
    path = f"{base}/occurrences/{occurrence.id}/capture-override"
    assert client.patch(path, json={"capture_override": "off"}).status_code == 404
    app.dependency_overrides[auth.get_current_user] = lambda: User(
        id=ACTOR, email="owner@example.com"
    )
    assert (
        client.patch(
            path, json={"capture_override": "off", "version": occurrence.revision + 1}
        ).status_code
        == 409
    )
    assert (
        client.patch(
            path, json={"capture_override": "off", "version": occurrence.revision}
        ).status_code
        == 200
    )
    assert db_session.get(CaptureRequest, request_id).status == CaptureRequestStatus.CANCELLED


@pytest.mark.asyncio
async def test_future_capture_does_not_dispatch_before_start_and_policy_rechecked(
    db_session, setup
):
    org, connection, store = setup
    upcoming = event()
    await sync_calendar_connection(db_session, connection, Calendar([upcoming]), secret_store=store)
    db_session.add(
        ProviderBinding(
            org_id=org.id,
            provider="vexa",
            account_scope_id="test-account",
            endpoint_ref="configured",
            secret_ref="key",
        )
    )
    db_session.commit()

    class Provider:
        calls = 0

        async def start(self, target):
            self.calls += 1
            return CaptureSnapshot(
                reference=CaptureReference(
                    provider="vexa",
                    record_id="one",
                    platform=target.platform,
                    native_meeting_id=target.native_meeting_id,
                ),
                status=CaptureStatus.JOINING,
                provider_status="joining",
            )

    provider = Provider()

    class Resolver:
        async def resolve(self, binding):
            return provider

    sessions = sessionmaker(bind=db_session.bind, expire_on_commit=False)
    assert not await dispatch_next(
        sessions,
        secret_store=store,
        provider_resolver=Resolver(),
        worker_id="calendar-test",
        now=datetime.now(UTC),
    )
    assert provider.calls == 0
    org.capture_policy = "off"
    db_session.commit()
    await dispatch_next(
        sessions,
        secret_store=store,
        provider_resolver=Resolver(),
        worker_id="calendar-test",
        now=upcoming.start_at,
    )
    assert provider.calls == 0
    db_session.expire_all()
    assert db_session.scalar(select(CaptureRequest)).status == CaptureRequestStatus.CANCELLED


def test_manual_intake_assigns_project_atomically_and_retries_without_duplicate(
    client, db_session, setup
):
    org, _, store = setup
    project = Project(org_id=org.id, name="Customer project")
    db_session.add(project)
    db_session.flush()
    db_session.add(ProjectMember(org_id=org.id, project_id=project.id, user_id=ACTOR, role="owner"))
    db_session.commit()
    app.dependency_overrides[secrets] = lambda: store
    body = {
        "meeting_url": "https://meet.google.com/abc-defg-hij",
        "project_id": project.id,
        "title": "Ad hoc",
    }
    headers = {"Idempotency-Key": "one-owned-request"}
    path = f"/api/v2/workspaces/{org.id}/captures"
    first = client.post(path, json=body, headers=headers)
    assert first.status_code == 202
    second = client.post(path, json=body, headers=headers)
    assert second.status_code == 200 and second.json()["id"] == first.json()["id"]
    assert (
        client.post(path, json={**body, "title": "Different"}, headers=headers).status_code == 409
    )
    assert db_session.scalar(select(func.count()).select_from(Meeting)) == 1
    assert (
        client.get(f"/api/v2/workspaces/{org.id}/meetings/{first.json()['meeting_id']}").json()[
            "project_id"
        ]
        == project.id
    )


def test_signed_oauth_actor_is_not_guessed_from_provider_email():
    state = sign_state(org_id="org", provider="google", secret="test", user_id=ACTOR)
    assert verify_state_actor(state, provider="google", secret="test") == ACTOR
    legacy = sign_state(org_id="org", provider="google", secret="test")
    assert verify_state_actor(legacy, provider="google", secret="test") is None


@pytest.mark.asyncio
async def test_scheduled_end_is_not_a_stop_signal_for_an_overrunning_call(db_session, setup):
    from app.modules.calendars.durable_capture import sync_snapshot

    _, connection, store = setup
    upcoming = event()
    identifier = (
        await sync_snapshot(db_session, connection, [upcoming], store, within=timedelta(days=1))
    )[0]
    request = db_session.get(CaptureRequest, identifier)
    request.status = CaptureRequestStatus.MONITORING
    db_session.commit()
    assert (
        await sync_snapshot(
            db_session,
            connection,
            [upcoming],
            store,
            within=timedelta(days=1),
            now=upcoming.end_at + timedelta(minutes=10),
        )
        == []
    )
    assert request.status == CaptureRequestStatus.MONITORING
    assert request.stop_state == CaptureStopState.NOT_REQUESTED


@pytest.mark.asyncio
async def test_manual_stop_prevents_calendar_sync_restarting_same_occurrence(
    client, db_session, setup
):
    org, connection, store = setup
    upcoming = event()
    identifier = (
        await sync_calendar_connection(
            db_session, connection, Calendar([upcoming]), secret_store=store
        )
    )[0]
    response = client.post(f"/api/v2/workspaces/{org.id}/capture-requests/{identifier}/stop")
    assert response.status_code == 202
    assert (
        await sync_calendar_connection(
            db_session, connection, Calendar([upcoming]), secret_store=store
        )
        == []
    )
    assert db_session.scalar(select(CalendarOccurrence)).capture_override == "off"
    assert db_session.scalar(select(func.count()).select_from(CaptureRequest)) == 1


def test_rejected_intake_cleans_its_provisional_secret(client, db_session, setup):
    org, _, store = setup
    org.capture_policy = "off"
    db_session.commit()
    app.dependency_overrides[secrets] = lambda: store
    response = client.post(
        f"/api/v2/workspaces/{org.id}/captures",
        json={"meeting_url": "https://meet.google.com/abc-defg-hij"},
        headers={"Idempotency-Key": "rejected"},
    )
    assert response.status_code == 409
    assert store.values == {}
    assert db_session.scalar(select(func.count()).select_from(Meeting)) == 0


@pytest.mark.asyncio
async def test_policy_revoked_during_secret_io_cleans_unreferenced_calendar_url(db_session, setup):
    org, connection, store = setup
    original = store.put

    async def revoke(name, value):
        await original(name, value)
        org.pilot_features_enabled = False
        db_session.commit()

    store.put = revoke
    assert (
        await sync_calendar_connection(
            db_session, connection, Calendar([event()]), secret_store=store
        )
        == []
    )
    assert store.values == {}
    assert db_session.scalar(select(func.count()).select_from(CaptureRequest)) == 0
