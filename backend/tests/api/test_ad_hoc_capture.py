"""Calendar-independent capture, recovery and privacy against real DB contracts."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.capture.dispatcher import dispatch_next
from app.capture.reconciler import reconcile_next
from app.capture.requests import CaptureRequestConflict
from app.capture.transcript_bridge import ingest_next
from app.db.models import (
    CalendarConnection,
    CalendarOccurrence,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureSession,
    CaptureState,
    Meeting,
    MeetingAssignment,
    Org,
    OrgMember,
    OutboxEvent,
    PipelineJob,
    Project,
    ProjectMember,
    ProviderBinding,
    User,
    Utterance,
)
from app.interfaces.capture_provider import (
    CaptureReference,
    CaptureSnapshot,
    CaptureStatus,
    TranscriptSegment,
    TranscriptSnapshot,
)
from app.main import app
from app.modules.capture.api import secrets
from app.modules.capture.intake import capture_meeting

ACTOR = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


class Store:
    def __init__(self):
        self.values = {}

    async def put(self, name, value):
        self.values[name] = value

    async def get(self, name):
        return self.values[name]

    async def delete(self, name):
        self.values.pop(name, None)


@pytest.fixture
def adhoc(db_session, client):
    org = Org(
        name="No calendar workspace",
        pilot_features_enabled=True,
        capture_policy="manual",
        disclosure_ack_at=datetime.now(UTC),
    )
    db_session.add(org)
    db_session.add_all(
        [User(id=ACTOR, email="one@example.com"), User(id=OTHER, email="two@example.com")]
    )
    db_session.flush()
    db_session.add_all(
        [
            OrgMember(org_id=org.id, user_id=ACTOR, role="owner"),
            OrgMember(org_id=org.id, user_id=OTHER, role="member"),
            ProviderBinding(
                org_id=org.id,
                provider="vexa",
                account_scope_id="adhoc",
                endpoint_ref="test",
                secret_ref="test",
            ),
        ]
    )
    db_session.commit()
    store = Store()
    app.dependency_overrides[secrets] = lambda: store
    return org, store


def capture(client, org, *, key="instant", url="https://meet.google.com/abc-defg-hij", **fields):
    return client.post(
        f"/api/v2/workspaces/{org.id}/captures",
        headers={"Idempotency-Key": key},
        json={"meeting_url": url, "estimated_seconds": 60, **fields},
    )


@pytest.mark.parametrize(
    "url,platform",
    [
        ("https://meet.google.com/abc-defg-hij", "google_meet"),
        ("https://us02web.zoom.us/j/12345678901?pwd=encoded-passcode", "zoom"),
        (
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0?context=%7B%7D",
            "teams",
        ),
    ],
)
def test_paste_link_without_any_calendar_creates_private_durable_intent(
    client, db_session, adhoc, url, platform
):
    org, store = adhoc
    result = capture(client, org, url=url, title="Customer call")
    assert result.status_code == 202, result.text
    request = db_session.get(CaptureRequest, result.json()["id"])
    meeting = db_session.get(Meeting, request.meeting_id)
    assert request.platform == platform
    assert request.requested_by == meeting.owner_user_id == ACTOR
    assert request.policy_snapshot["language"] == "en"
    assert meeting.title == "Customer call"
    assert db_session.scalar(select(func.count()).select_from(CalendarConnection)) == 0
    assert db_session.scalar(select(func.count()).select_from(CalendarOccurrence)) == 0
    assert db_session.scalar(select(func.count()).select_from(MeetingAssignment)) == 0
    assert db_session.scalar(select(func.count()).select_from(CaptureSession)) == 0
    queued = db_session.scalar(
        select(OutboxEvent).where(OutboxEvent.operation == "capture.dispatch")
    )
    assert queued.entity_id == request.id
    assert queued.run_at.replace(tzinfo=UTC) <= datetime.now(UTC)
    assert len(store.values) == 1
    assert store.values[request.meeting_url_secret_ref] == url
    readiness = client.get(f"/api/v2/workspaces/{org.id}/capture-readiness").json()
    assert readiness["manual_capture_enabled"] and readiness["provider_configured"]
    assert not readiness["automatic_capture_enabled"] and not readiness["live_join_verified"]


def test_duplicate_new_key_refused_but_idempotent_retry_and_later_occurrence_allowed(
    client, db_session, adhoc
):
    org, store = adhoc
    first = capture(client, org)
    assert first.status_code == 202
    retry = capture(client, org)
    assert retry.status_code == 200 and retry.json()["id"] == first.json()["id"]
    assert capture(client, org, key="another-browser").status_code == 409
    assert len(store.values) == 1
    assert db_session.scalar(select(func.count()).select_from(Meeting)) == 1
    path = f"/api/v2/workspaces/{org.id}/capture-requests/{first.json()['id']}"
    stopped = client.post(path + "/stop")
    assert stopped.status_code == 202 and stopped.json()["status"] == "cancelled"
    assert client.post(path + "/stop").status_code == 202
    assert capture(client, org, key="next-meeting").status_code == 202


def test_future_calendar_intent_does_not_block_impromptu_link(client, db_session, adhoc):
    org, _ = adhoc
    result = capture(client, org)
    event = db_session.scalar(
        select(OutboxEvent).where(OutboxEvent.entity_id == result.json()["id"])
    )
    event.run_at = datetime.now(UTC) + timedelta(days=1)
    db_session.commit()
    assert capture(client, org, key="meeting-now").status_code == 202


@pytest.mark.parametrize(
    "role,status", [("owner", 202), ("editor", 202), ("viewer", 404), (None, 404)]
)
def test_project_capture_requires_explicit_edit_membership(client, db_session, adhoc, role, status):
    org, store = adhoc
    project = Project(org_id=org.id, name="Customer history")
    db_session.add(project)
    db_session.flush()
    if role:
        db_session.add(
            ProjectMember(org_id=org.id, project_id=project.id, user_id=ACTOR, role=role)
        )
    db_session.commit()
    result = capture(client, org, project_id=project.id)
    assert result.status_code == status, result.text
    assert len(store.values) == (1 if status == 202 else 0)
    if status == 202:
        assert db_session.scalar(select(MeetingAssignment)).project_id == project.id
    else:
        assert db_session.scalar(select(func.count()).select_from(Meeting)) == 0


def test_private_recovery_list_filters_before_pagination_and_never_exposes_url(
    client, db_session, adhoc
):
    org, _ = adhoc
    own_ids = []
    for index, suffix in enumerate(["hij", "hik", "hil"]):
        result = capture(
            client, org, key=str(index), url=f"https://meet.google.com/abc-defg-{suffix}"
        )
        assert result.status_code == 202
        own_ids.append(result.json()["id"])
    hidden = db_session.get(CaptureRequest, own_ids.pop())
    hidden.requested_by = OTHER
    db_session.get(Meeting, hidden.meeting_id).owner_user_id = OTHER
    db_session.commit()
    root = f"/api/v2/workspaces/{org.id}/capture-requests"
    first = client.get(root + "?limit=1")
    assert first.status_code == 200
    assert len(first.json()["items"]) == 1 and first.json()["next_cursor"]
    second = client.get(root, params={"limit": 1, "cursor": first.json()["next_cursor"]})
    assert second.status_code == 200 and second.json()["next_cursor"] is None
    assert {first.json()["items"][0]["id"], second.json()["items"][0]["id"]} == set(own_ids)
    assert client.get(root + "/" + hidden.id).status_code == 404
    assert "meeting_url" not in first.text and "secret" not in first.text
    assert client.get(root + "?limit=101").status_code == 422
    assert client.get(root + "?cursor=not-a-cursor").status_code == 422


def test_recovered_capture_uses_processing_session_not_meeting_id(client, db_session, adhoc):
    org, _ = adhoc
    result = capture(client, org)
    request = db_session.get(CaptureRequest, result.json()["id"])
    session = CaptureSession(
        org_id=org.id, meeting_id=request.meeting_id, mode="B", state=CaptureState.UNDERSTANDING
    )
    db_session.add(session)
    db_session.flush()
    request.capture_session_id = session.id
    request.status = CaptureRequestStatus.FINALIZED
    db_session.commit()
    path = f"/api/v2/workspaces/{org.id}/capture-requests/{request.id}"
    view = client.get(path).json()
    assert view["capture_session_id"] == session.id != request.meeting_id
    assert view["processing_state"] == "understanding" and not view["report_ready"]
    session.state = CaptureState.DONE
    db_session.commit()
    assert client.get(path).json()["report_ready"]
    assert client.get(f"/api/v2/workspaces/{org.id}/capture-requests").json()["items"][0][
        "report_ready"
    ]


def test_request_cannot_project_another_meetings_processing_session(client, db_session, adhoc):
    org, _ = adhoc
    result = capture(client, org)
    other = Meeting(org_id=org.id, owner_user_id=OTHER, platform="google_meet", title="Hidden call")
    db_session.add(other)
    db_session.flush()
    session = CaptureSession(org_id=org.id, meeting_id=other.id, mode="B", state=CaptureState.DONE)
    db_session.add(session)
    db_session.flush()
    request = db_session.get(CaptureRequest, result.json()["id"])
    request.capture_session_id = session.id
    db_session.commit()
    root = f"/api/v2/workspaces/{org.id}/capture-requests"
    for view in [client.get(root + "/" + request.id).json(), client.get(root).json()["items"][0]]:
        assert view["capture_session_id"] is None
        assert view["processing_state"] is None and not view["report_ready"]


def test_policy_off_rejects_capture_and_cleans_provisional_secret(client, db_session, adhoc):
    org, store = adhoc
    org.capture_policy = "off"
    db_session.commit()
    assert capture(client, org).status_code == 409
    assert not store.values
    assert db_session.scalar(select(func.count()).select_from(Meeting)) == 0


def test_revoked_project_access_hides_request_even_from_original_requester(
    client, db_session, adhoc
):
    org, _ = adhoc
    project = Project(org_id=org.id, name="Private project")
    db_session.add(project)
    db_session.flush()
    member = ProjectMember(org_id=org.id, project_id=project.id, user_id=ACTOR, role="editor")
    db_session.add(member)
    db_session.commit()
    result = capture(client, org, project_id=project.id)
    assert result.status_code == 202
    db_session.delete(member)
    db_session.commit()
    root = f"/api/v2/workspaces/{org.id}/capture-requests"
    assert client.get(root).json()["items"] == []
    assert client.get(root + "/" + result.json()["id"]).status_code == 404
    assert client.post(root + "/" + result.json()["id"] + "/stop").status_code == 404


def test_invalid_link_and_cross_workspace_project_leave_no_capture(client, db_session, adhoc):
    org, store = adhoc
    assert (
        capture(
            client, org, url="https://meet.google.com.attacker.example/abc-defg-hij"
        ).status_code
        == 422
    )
    other_org = Org(name="Other workspace")
    db_session.add(other_org)
    db_session.flush()
    project = Project(org_id=other_org.id, name="Not yours")
    db_session.add(project)
    db_session.commit()
    assert capture(client, org, project_id=project.id).status_code == 404
    assert not store.values
    assert db_session.scalar(select(func.count()).select_from(CaptureRequest)) == 0


def test_two_concurrent_browser_keys_serialize_under_postgres_workspace_lock(db_session, adhoc):
    if db_session.bind.dialect.name != "postgresql":
        pytest.skip("requires PostgreSQL row locking")
    org, _ = adhoc
    org_id = org.id
    barrier = Barrier(2)

    class ConcurrentStore(Store):
        async def put(self, name, value):
            await super().put(name, value)
            barrier.wait(timeout=10)

    store = ConcurrentStore()
    factory = sessionmaker(bind=db_session.bind, expire_on_commit=False)

    def send(key):
        with factory() as session:
            try:
                result = asyncio.run(
                    capture_meeting(
                        session,
                        store,
                        org_id=org_id,
                        actor_id=ACTOR,
                        key=key,
                        meeting_url="https://meet.google.com/abc-defg-hij",
                        title="Parallel call",
                        project_id=None,
                        estimated_seconds=60,
                    )
                )
                return result.created
            except CaptureRequestConflict:
                return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(send, key) for key in ["browser-one", "browser-two"]]
        assert sorted(future.result(timeout=20) for future in futures) == [False, True]
    assert db_session.scalar(select(func.count()).select_from(CaptureRequest)) == 1
    assert db_session.scalar(select(func.count()).select_from(Meeting)) == 1
    assert len(store.values) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("user_stop", [False, True])
async def test_calendar_free_request_dispatches_until_provider_end_then_ingests(
    client, db_session, adhoc, user_stop
):
    org, store = adhoc
    result = capture(client, org)
    assert result.status_code == 202
    path = f"/api/v2/workspaces/{org.id}/capture-requests/{result.json()['id']}"

    class Provider:
        state = CaptureStatus.CAPTURING
        starts = 0
        stops = 0

        def snapshot(self, reference):
            return CaptureSnapshot(
                reference=reference, status=self.state, provider_status=self.state.value
            )

        async def start(self, target):
            self.starts += 1
            return self.snapshot(
                CaptureReference(
                    provider="vexa",
                    record_id="immutable-record",
                    platform=target.platform,
                    native_meeting_id=target.native_meeting_id,
                )
            )

        async def status(self, reference):
            return self.snapshot(reference)

        async def transcript(self, reference):
            return TranscriptSnapshot(
                capture=self.snapshot(reference),
                segments=[
                    TranscriptSegment(
                        id="s1",
                        start_s=0,
                        end_s=4,
                        text="We agreed to schedule a follow-up.",
                        final=True,
                    )
                ],
            )

        async def stop(self, reference):
            self.stops += 1
            self.state = CaptureStatus.ENDED

    provider = Provider()

    class Resolver:
        async def resolve(self, binding):
            return provider

    factory = sessionmaker(bind=db_session.bind, expire_on_commit=False)
    now = datetime.now(UTC)
    assert await dispatch_next(
        factory, secret_store=store, provider_resolver=Resolver(), worker_id="adhoc-test", now=now
    )
    assert provider.starts == 1
    assert client.get(path).json()["provider_state"] == "capturing"
    assert not client.get(path).json()["report_ready"]
    if user_stop:
        assert client.post(path + "/stop").status_code == 202
    else:
        provider.state = CaptureStatus.ENDED
    assert await reconcile_next(
        factory,
        provider_resolver=Resolver(),
        worker_id="adhoc-test",
        now=now + timedelta(seconds=60),
    )
    if user_stop:
        assert await reconcile_next(
            factory,
            provider_resolver=Resolver(),
            worker_id="adhoc-test",
            now=now + timedelta(seconds=120),
        )
    status = client.get(path).json()
    assert status["status"] == "finalized"
    assert status["stop_state"] == ("confirmed" if user_stop else "not_requested")
    assert provider.stops == (1 if user_stop else 0)
    assert await ingest_next(
        factory,
        provider_resolver=Resolver(),
        worker_id="adhoc-test",
        now=now + timedelta(seconds=180),
    )
    status = client.get(path).json()
    assert status["capture_session_id"] and not status["report_ready"]
    assert db_session.scalar(select(func.count()).select_from(Utterance)) == 1
    assert db_session.scalar(select(func.count()).select_from(PipelineJob)) == 1
    assert not await ingest_next(
        factory,
        provider_resolver=Resolver(),
        worker_id="adhoc-test",
        now=now + timedelta(seconds=180),
    )
    assert provider.starts == 1
