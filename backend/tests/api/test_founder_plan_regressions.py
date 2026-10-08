"""Adversarial checks for the founder-plan access and freshness boundaries."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from decimal import Decimal
from threading import Barrier
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.api.threads import ThreadUpdate, update_thread
from app.auth import dependency as auth_dep
from app.capture.requests import CaptureMinuteLimitError, create_capture_request
from app.db.models import (
    AnswerCitation,
    CalendarConnection,
    CalendarOccurrence,
    CaptureRequest,
    CaptureSession,
    CaptureState,
    ChatMessage,
    ChatThread,
    Confidence,
    Customer,
    KnowledgeEdge,
    KnowledgeEvidence,
    KnowledgeItem,
    KnowledgeType,
    Meeting,
    MeetingAssignment,
    MessageRole,
    MessageState,
    Org,
    OrgMember,
    Project,
    ProjectMember,
    ProjectRole,
    ProposedAction,
    UsageReservation,
    UsageReservationStatus,
    User,
    Utterance,
)
from app.interfaces.capture_provider import MeetingTarget
from app.main import app

A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


def actor(user_id):
    app.dependency_overrides[auth_dep.get_current_user] = lambda: User(
        id=user_id, email=f"{user_id}@example.com"
    )


@pytest.fixture
def fixture_data(db_session):
    db = db_session
    org = Org(
        name="Founder workspace", capture_policy="manual", disclosure_ack_at=datetime.now(UTC)
    )
    db.add(org)
    db.flush()
    for user_id in (A, B):
        db.add(User(id=user_id, email=f"{user_id}@example.com"))
    db.flush()
    for user_id in (A, B):
        db.add(OrgMember(org_id=org.id, user_id=user_id, role="owner"))
    customer = Customer(org_id=org.id, name="Acme")
    db.add(customer)
    db.flush()
    projects, meetings, sessions, claims = [], [], [], []
    for index in range(2):
        project = Project(org_id=org.id, customer_id=customer.id, name=f"Project {index}")
        db.add(project)
        db.flush()
        db.add(
            ProjectMember(org_id=org.id, project_id=project.id, user_id=A, role=ProjectRole.OWNER)
        )
        if index == 0:
            db.add(
                ProjectMember(
                    org_id=org.id, project_id=project.id, user_id=B, role=ProjectRole.VIEWER
                )
            )
        meeting = Meeting(org_id=org.id, title=f"Call {index}", platform="meet", owner_user_id=A)
        db.add(meeting)
        db.flush()
        db.add(
            MeetingAssignment(
                org_id=org.id, meeting_id=meeting.id, project_id=project.id, assigned_by=A
            )
        )
        session = CaptureSession(
            org_id=org.id, meeting_id=meeting.id, mode="B", state=CaptureState.DONE
        )
        db.add(session)
        db.flush()
        claim = KnowledgeItem(
            org_id=org.id,
            capture_session_id=session.id,
            type=KnowledgeType.DECISION,
            statement=f"Use database secret-{index}",
            confidence=Confidence.VERIFIED,
        )
        db.add(claim)
        projects.append(project)
        meetings.append(meeting)
        sessions.append(session)
        claims.append(claim)
    db.commit()
    actor(A)
    return org, customer, projects, meetings, sessions, claims


def test_customer_cache_is_keyed_by_current_authorized_sources(client, db_session, fixture_data):
    org, customer, _, meetings, _, _ = fixture_data
    path = f"/api/v2/workspaces/{org.id}/customers/{customer.id}/memory"
    owner = client.get(path).json()
    assert set(owner["source_meeting_ids"]) == {m.id for m in meetings}
    actor(B)
    viewer = client.get(path).json()
    assert viewer["source_meeting_ids"] == [meetings[0].id]
    assert "secret-1" not in str(viewer)
    assert viewer["id"] != owner["id"]
    membership = db_session.scalar(select(ProjectMember).where(ProjectMember.user_id == B))
    db_session.delete(membership)
    db_session.commit()
    revoked = client.get(path).json()
    assert revoked["source_meeting_ids"] == []
    assert "secret-0" not in str(revoked)


def test_project_meeting_browser_filters_before_pagination(client, fixture_data):
    org, customer, projects, meetings, _, _ = fixture_data
    base = f"/api/v2/workspaces/{org.id}"
    assert [
        row["id"]
        for row in client.get(f"{base}/meetings?project_id={projects[1].id}").json()["items"]
    ] == [meetings[1].id]
    actor(B)
    assert client.get(f"{base}/projects/{projects[1].id}").status_code == 404
    assert client.get(f"{base}/projects/{projects[1].id}/members").status_code == 404
    assert client.get(f"{base}/meetings/{meetings[1].id}").status_code == 404
    assert client.get(f"{base}/meetings?project_id={projects[1].id}").status_code == 404
    result = client.get(f"{base}/meetings?customer_id={customer.id}&limit=1").json()
    assert [row["id"] for row in result["items"]] == [meetings[0].id]
    assert result["next_cursor"] is None
    assert result["items"][0]["can_move"] is False


def test_unassigned_inbox_is_owned_not_legacy_workspace_shared(client, db_session, fixture_data):
    org, _, _, _, _, _ = fixture_data
    owned = Meeting(org_id=org.id, owner_user_id=B, title="Private inbox")
    legacy = Meeting(org_id=org.id, title="Unknown owner")
    db_session.add_all([owned, legacy])
    db_session.commit()
    path = f"/api/v2/workspaces/{org.id}/meetings?unassigned=true"
    assert client.get(path).json()["items"] == []
    actor(B)
    assert [row["id"] for row in client.get(path).json()["items"]] == [owned.id]


def test_project_roster_excludes_removed_workspace_members(client, db_session, fixture_data):
    org, _, projects, _, _, _ = fixture_data
    membership = db_session.scalar(
        select(OrgMember).where(OrgMember.org_id == org.id, OrgMember.user_id == B)
    )
    db_session.delete(membership)
    db_session.commit()
    response = client.get(f"/api/v2/workspaces/{org.id}/projects/{projects[0].id}/members")
    assert response.status_code == 200
    assert [row["user_id"] for row in response.json()] == [A]


@pytest.mark.parametrize("intake", ["upload", "companion", "instant"])
def test_new_manual_meeting_is_owned_and_assignable(
    client, db_session, fixture_data, monkeypatch, intake
):
    from app.api import capture, upload

    org, _, projects, _, _, _ = fixture_data

    class Store:
        async def put_stream(self, key, stream, content_type=None):
            async for _ in stream:
                pass
            return f"blob://{key}"

    if intake == "upload":
        monkeypatch.setattr(upload, "get_blobstore", lambda: Store())
        response = client.post(
            "/api/v1/meetings/upload",
            data={"org_id": org.id, "title": "Owned upload"},
            files={"file": ("test.wav", b"test-audio", "audio/wav")},
        )
        assert response.status_code == 200
        meeting_id = response.json()["meeting_id"]
    elif intake == "companion":
        response = client.post(
            f"/api/v1/orgs/{org.id}/companion/sessions",
            json={"meeting_url": "https://meet.google.com/abc-defg-hij", "platform": "meet"},
        )
        assert response.status_code == 200
        meeting_id = db_session.get(CaptureSession, response.json()["session_id"]).meeting_id
    else:
        monkeypatch.setattr(
            capture,
            "get_settings",
            lambda: SimpleNamespace(
                bot_google_guest_enabled=True,
                bot_dispatch_enabled=True,
                bot_google_join_mode="guest",
                bot_google_account_email=None,
            ),
        )
        response = client.post(
            f"/api/v1/orgs/{org.id}/capture/instant",
            json={"url": "https://meet.google.com/abc-defg-hij"},
        )
        assert response.status_code == 200
        meeting_id = response.json()["meeting_id"]
    assert db_session.get(Meeting, meeting_id).owner_user_id == A
    base = f"/api/v2/workspaces/{org.id}"
    assert meeting_id in {
        row["id"] for row in client.get(f"{base}/meetings?unassigned=true").json()["items"]
    }
    actor(B)
    assert client.get(f"{base}/meetings/{meeting_id}").status_code == 404
    actor(A)
    assert (
        client.put(
            f"{base}/meetings/{meeting_id}/assignment",
            json={"project_id": projects[0].id, "version": 0},
        ).status_code
        == 200
    )


def test_owned_meeting_cannot_be_moved_by_source_project_viewer(client, db_session, fixture_data):
    org, _, projects, meetings, _, _ = fixture_data
    membership = db_session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == projects[0].id, ProjectMember.user_id == A
        )
    )
    membership.role = ProjectRole.VIEWER
    db_session.commit()
    base = f"/api/v2/workspaces/{org.id}"
    assert client.get(f"{base}/meetings/{meetings[0].id}").json()["can_move"] is False
    response = client.put(
        f"{base}/meetings/{meetings[0].id}/assignment",
        json={"project_id": projects[1].id, "version": 1},
    )
    assert response.status_code == 403
    assert client.get(f"{base}/meetings/{meetings[0].id}").json()["project_id"] == projects[0].id


def test_meeting_cursor_is_stable_and_malformed_cursor_rejected(client, db_session, fixture_data):
    org, _, _, _, _, _ = fixture_data
    db_session.add_all(
        [
            Meeting(
                org_id=org.id,
                owner_user_id=A,
                title=f"Call {index}",
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
            for index in range(3)
        ]
    )
    db_session.commit()
    path = f"/api/v2/workspaces/{org.id}/meetings?limit=1"
    ids = []
    for _ in range(7):
        response = client.get(path)
        assert response.status_code == 200
        page = response.json()
        ids.extend(row["id"] for row in page["items"])
        if not page["next_cursor"]:
            break
        path = f"/api/v2/workspaces/{org.id}/meetings?limit=1&cursor={page['next_cursor']}"
    assert len(ids) == len(set(ids)) == 5
    assert (
        client.get(f"/api/v2/workspaces/{org.id}/meetings?cursor=not-a-cursor").status_code == 422
    )
    assert client.get(f"/api/v2/workspaces/{org.id}/meetings?limit=101").status_code == 422


def test_assignment_conflict_does_not_move_meeting_or_restore_stale_memory(client, fixture_data):
    org, _, projects, meetings, _, _ = fixture_data
    base = f"/api/v2/workspaces/{org.id}"
    before = client.get(f"{base}/projects/{projects[0].id}/memory").json()
    path = f"{base}/meetings/{meetings[0].id}/assignment"
    moved = client.put(path, json={"project_id": projects[1].id, "version": 1})
    assert moved.status_code == 200
    assert moved.json()["version"] == 2
    stale = client.put(path, json={"project_id": projects[0].id, "version": 1})
    assert stale.status_code == 409
    assert client.delete(f"{path}?version=1").status_code == 409
    current = client.get(f"{base}/meetings/{meetings[0].id}").json()
    assert current["project_id"] == projects[1].id
    after = client.get(f"{base}/projects/{projects[0].id}/memory").json()
    assert after["id"] != before["id"] and after["source_meeting_ids"] == []
    assert client.delete(f"{path}?version=2").status_code == 204
    assert client.get(f"{base}/meetings/{meetings[0].id}").json()["project_id"] is None


def test_memory_refreshes_when_claim_changes_without_new_meeting(client, db_session, fixture_data):
    org, _, projects, _, _, claims = fixture_data
    path = f"/api/v2/workspaces/{org.id}/projects/{projects[0].id}/memory"
    before = client.get(path).json()
    claims[0].statement = "We corrected the decision to use SQLite"
    db_session.commit()
    after = client.get(path).json()
    assert before["id"] != after["id"]
    assert "SQLite" in str(after)
    claims[0].confidence = Confidence.UNSUPPORTED
    db_session.commit()
    assert client.get(path).json()["structured_summary"]["decisions"] == []


@pytest.mark.parametrize("operation", ["list", "messages", "send", "edit"])
def test_project_thread_revocation_is_immediate(client, db_session, fixture_data, operation):
    org, _, projects, _, _, _ = fixture_data
    actor(B)
    base = f"/api/v2/workspaces/{org.id}/threads"
    thread = client.post(
        base, json={"scope_kind": "project", "scope_id": projects[0].id, "title": "My notes"}
    ).json()
    member = db_session.scalar(select(ProjectMember).where(ProjectMember.user_id == B))
    db_session.delete(member)
    db_session.commit()
    if operation == "list":
        assert client.get(base).json() == []
    elif operation == "messages":
        assert client.get(f"{base}/{thread['id']}/messages").status_code == 404
    elif operation == "send":
        assert (
            client.post(
                f"{base}/{thread['id']}/messages",
                json={"text": "Reveal it", "client_request_id": str(uuid.uuid4())},
            ).status_code
            == 404
        )
    else:
        assert (
            client.patch(
                f"{base}/{thread['id']}", json={"version": 1, "title": "Reveal"}
            ).status_code
            == 404
        )


def test_customer_thread_redacts_old_answer_after_source_revocation(
    client, db_session, fixture_data
):
    org, customer, _, meetings, _, _ = fixture_data
    actor(B)
    thread = ChatThread(org_id=org.id, scope_kind="customer", scope_id=customer.id, creator_id=B)
    db_session.add(thread)
    db_session.flush()
    answer = ChatMessage(
        org_id=org.id,
        thread_id=thread.id,
        role=MessageRole.ASSISTANT,
        state=MessageState.DONE,
        content="Use database secret-0",
    )
    db_session.add(answer)
    db_session.flush()
    db_session.add(AnswerCitation(org_id=org.id, message_id=answer.id, meeting_id=meetings[0].id))
    member = db_session.scalar(select(ProjectMember).where(ProjectMember.user_id == B))
    db_session.delete(member)
    db_session.commit()
    result = client.get(f"/api/v2/workspaces/{org.id}/threads/{thread.id}/messages").json()
    assert "secret-0" not in str(result)
    assert result[0]["state"] == "failed"
    db_session.expire_all()
    assert db_session.get(ChatMessage, answer.id).content == "Use database secret-0"


def test_message_idempotency_rejects_changed_text(client, fixture_data):
    org, _, projects, _, _, _ = fixture_data
    base = f"/api/v2/workspaces/{org.id}/threads"
    thread = client.post(base, json={"scope_kind": "project", "scope_id": projects[0].id}).json()
    body = {"text": "First question", "client_request_id": str(uuid.uuid4())}
    path = f"{base}/{thread['id']}/messages"
    assert client.post(path, json=body).status_code == 202
    assert client.post(path, json={**body, "text": "Different question"}).status_code == 409


def test_private_meetings_are_hidden_from_legacy_reads_and_graph_neighbors(
    client, db_session, fixture_data
):
    org, _, _, meetings, sessions, claims = fixture_data
    db_session.add(
        KnowledgeEdge(
            org_id=org.id, from_item_id=claims[0].id, to_item_id=claims[1].id, kind="continues"
        )
    )
    db_session.commit()
    actor(B)
    index = client.get(f"/api/v1/orgs/{org.id}/meetings").json()
    assert [m["id"] for m in index] == [meetings[0].id]
    assert (
        client.get(f"/api/v1/orgs/{org.id}/meetings/{meetings[1].id}/capture-status").status_code
        == 404
    )
    assert client.get(f"/api/v1/meetings/{sessions[1].id}/report").status_code == 404
    assert client.get(f"/api/v1/meetings/{sessions[1].id}/utterances").status_code == 404
    chat = client.post("/api/v1/chat", json={"org_id": org.id, "question": "database"})
    assert chat.status_code == 200
    assert "secret-0" in str(chat.json())
    assert "secret-1" not in str(chat.json())


@pytest.mark.parametrize(
    "suffix",
    [
        "/people",
        "/people/person/analysis/latest",
        "/people/person",
        "/people/person/items/item/lifecycle",
        "/people/interactions/map",
        "/glossary",
    ],
)
def test_legacy_aggregates_fail_closed_for_restricted_workspace_admin(client, fixture_data, suffix):
    org, _, _, _, _, _ = fixture_data
    actor(B)
    response = client.get(f"/api/v1/orgs/{org.id}{suffix}")
    assert response.status_code == 403
    assert "secret-" not in str(response.json())
    actor(A)
    # Compatibility still works when every source is accessible.
    if suffix in {"/people", "/glossary"}:
        assert client.get(f"/api/v1/orgs/{org.id}{suffix}").status_code == 200


def test_unassigned_meeting_owner_and_viewer_assignment_policy(client, db_session, fixture_data):
    org, _, projects, _, _, _ = fixture_data
    meeting = Meeting(
        org_id=org.id, title="Private owner meeting", platform="meet", owner_user_id=B
    )
    db_session.add(meeting)
    db_session.commit()
    path = f"/api/v2/workspaces/{org.id}/meetings/{meeting.id}/assignment"
    # The project owner cannot take another founder's private meeting.
    assert client.put(path, json={"project_id": projects[0].id}).status_code == 404
    actor(B)
    # The meeting owner is a viewer, so cannot share it into this project.
    assert client.put(path, json={"project_id": projects[0].id}).status_code == 403


def test_agenda_context_respects_project_access(client, db_session, fixture_data):
    org, _, projects, meetings, _, _ = fixture_data
    conn = CalendarConnection(
        org_id=org.id, provider="google", account_email="calendar@example.com", secret_ref="ref"
    )
    db_session.add(conn)
    db_session.flush()
    occ = CalendarOccurrence(
        org_id=org.id,
        connection_id=conn.id,
        provider_event_id="private-event",
        title="Sensitive call",
        original_start=datetime.now(UTC),
        start_time=datetime.now(UTC),
        end_time=datetime.now(UTC),
        meeting_id=meetings[1].id,
    )
    db_session.add(occ)
    db_session.commit()
    base = f"/api/v2/workspaces/{org.id}"
    generated = client.post(f"{base}/occurrences/{occ.id}/agenda", json={}).json()
    assert "secret-1" in str(generated)
    actor(B)
    assert client.get(f"{base}/occurrences/{occ.id}/agenda").status_code == 404
    assert client.post(f"{base}/occurrences/{occ.id}/agenda", json={}).status_code == 404
    assert (
        client.patch(
            f"{base}/agendas/{generated['id']}", json={"version": 1, "sections": []}
        ).status_code
        == 404
    )


def test_agenda_get_returns_latest_generation(client, db_session, fixture_data):
    org, _, _, meetings, _, _ = fixture_data
    conn = CalendarConnection(
        org_id=org.id, provider="google", account_email="calendar@example.com", secret_ref="ref"
    )
    db_session.add(conn)
    db_session.flush()
    occ = CalendarOccurrence(
        org_id=org.id,
        connection_id=conn.id,
        provider_event_id="event",
        title="Call",
        original_start=datetime.now(UTC),
        start_time=datetime.now(UTC),
        end_time=datetime.now(UTC),
        meeting_id=meetings[0].id,
    )
    db_session.add(occ)
    db_session.commit()
    path = f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda"
    first = client.post(path, json={"objective": "One"}).json()
    second = client.post(path, json={"objective": "Two"}).json()
    assert second["version"] > first["version"]
    assert client.get(path).json()["id"] == second["id"]


def test_usage_reports_bot_seconds_and_zero_actual_minutes(client, db_session, fixture_data):
    org, _, _, meetings, _, _ = fixture_data
    request = CaptureRequest(
        org_id=org.id,
        meeting_id=meetings[0].id,
        requested_by=A,
        platform="google_meet",
        native_meeting_id="abc-defg-hij",
        meeting_url_secret_ref="ref",
        policy_snapshot={},
        input_hash="a" * 64,
        idempotency_key="usage",
    )
    db_session.add(request)
    db_session.flush()
    db_session.add(
        UsageReservation(
            org_id=org.id,
            request_id=request.id,
            unit="bot_second",
            estimated_quantity=Decimal("120"),
            actual_quantity=Decimal("0"),
            status=UsageReservationStatus.RECONCILED,
            expires_at=datetime.now(UTC),
        )
    )
    db_session.commit()
    assert (
        client.get(f"/api/v2/workspaces/{org.id}/usage").json()["capture"]["reconciled_minutes"]
        == 0
    )
    reservation = db_session.scalar(
        select(UsageReservation).where(UsageReservation.request_id == request.id)
    )
    reservation.status = UsageReservationStatus.RESERVED
    db_session.commit()
    assert (
        client.get(f"/api/v2/workspaces/{org.id}/usage").json()["capture"]["reserved_minutes"] == 2
    )


def test_capture_retry_at_cap_is_idempotent(client, db_session, fixture_data):
    org, _, _, meetings, _, _ = fixture_data
    org.capture_monthly_minutes = 1
    db_session.commit()
    args = dict(
        org_id=org.id,
        meeting_id=meetings[0].id,
        requested_by=A,
        idempotency_key="retry",
        target=MeetingTarget.from_url("https://meet.google.com/abc-defg-hij"),
        meeting_url_secret_ref="ref",
        policy_snapshot={},
        estimated_seconds=60,
    )
    first = create_capture_request(db_session, **args)
    db_session.commit()
    assert first.created
    assert not create_capture_request(db_session, **args).created


@pytest.mark.parametrize("same_key", [True, False])
def test_postgres_concurrent_capture_quota_and_idempotency(db_session, fixture_data, same_key):
    """Separate transactions contend on the real workspace row, not a mock lock."""
    bind = db_session.get_bind()
    if bind.dialect.name != "postgresql":
        pytest.skip("requires PostgreSQL row locks")
    org, _, _, meetings, _, _ = fixture_data
    org.capture_monthly_minutes = 1
    db_session.commit()
    org_id, meeting_id = org.id, meetings[0].id
    sessions = sessionmaker(bind=bind, expire_on_commit=False)
    barrier = Barrier(2)

    def submit(index):
        with sessions() as db:
            barrier.wait(timeout=20)
            try:
                result = create_capture_request(
                    db,
                    org_id=org_id,
                    meeting_id=meeting_id,
                    requested_by=A,
                    idempotency_key="parallel" if same_key else f"parallel-{index}",
                    target=MeetingTarget.from_url("https://meet.google.com/abc-defg-hij"),
                    meeting_url_secret_ref="ref",
                    policy_snapshot={},
                    estimated_seconds=60,
                )
                db.commit()
                return "created" if result.created else "existing"
            except CaptureMinuteLimitError:
                db.rollback()
                return "limited"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(submit, (0, 1)))
    assert sorted(results) == (["created", "existing"] if same_key else ["created", "limited"])
    assert (
        len(db_session.scalars(select(CaptureRequest).where(CaptureRequest.org_id == org_id)).all())
        == 1
    )
    assert (
        len(
            db_session.scalars(
                select(UsageReservation).where(UsageReservation.org_id == org_id)
            ).all()
        )
        == 1
    )


def test_postgres_thread_edit_versions_are_serialized(db_session, fixture_data):
    bind = db_session.get_bind()
    if bind.dialect.name != "postgresql":
        pytest.skip("requires PostgreSQL row locks")
    org, _, projects, _, _, _ = fixture_data
    thread = ChatThread(org_id=org.id, scope_kind="project", scope_id=projects[0].id, creator_id=A)
    db_session.add(thread)
    db_session.commit()
    org_id, thread_id = org.id, thread.id
    sessions = sessionmaker(bind=bind, expire_on_commit=False)
    barrier = Barrier(2)

    def edit(index):
        with sessions() as db:
            user = db.get(User, A)
            # Load a stale identity-map copy to exercise the refresh-under-lock path.
            cached = db.get(ChatThread, thread_id)
            barrier.wait(timeout=20)
            try:
                result = update_thread(
                    org_id, thread_id, ThreadUpdate(version=1, title=f"Edit {index}"), db, user
                )
                assert cached.version == result.version
                return result.version
            except HTTPException as exc:
                db.rollback()
                assert exc.status_code == 409
                assert cached.version == 2
                return "conflict"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(edit, (0, 1)))
    assert results.count(2) == 1
    assert results.count("conflict") == 1


@pytest.mark.parametrize("kind", ["exports", "deletions"])
def test_workspace_operations_reject_other_scope_id(client, fixture_data, kind):
    org, _, _, _, _, _ = fixture_data
    response = client.post(
        f"/api/v2/workspaces/{org.id}/{kind}",
        json={"scope_kind": "workspace", "scope_id": str(uuid.uuid4())},
    )
    assert response.status_code == 404


def test_private_actions_hidden_and_viewer_cannot_reject(client, db_session, fixture_data):
    org, _, _, _, sessions, _ = fixture_data
    actions = [
        ProposedAction(
            org_id=org.id,
            capture_session_id=session.id,
            kind="email_draft",
            payload={"title": f"private-action-{index}", "body": "Follow up"},
        )
        for index, session in enumerate(sessions)
    ]
    db_session.add_all(actions)
    db_session.commit()
    actor(B)
    for path in (f"/api/v1/orgs/{org.id}/actions", f"/api/v2/workspaces/{org.id}/proposals"):
        rows = client.get(path)
        assert rows.status_code == 200
        assert [row["id"] for row in rows.json()] == [actions[0].id]
    for index, action in enumerate(actions):
        expected = 403 if index == 0 else 404
        assert client.post(f"/api/v1/actions/{action.id}/reject").status_code == expected
        assert (
            client.post(f"/api/v2/workspaces/{org.id}/proposals/{action.id}/reject").status_code
            == expected
        )


def test_report_drops_cross_meeting_evidence_reference(client, db_session, fixture_data):
    org, _, _, _, sessions, claims = fixture_data
    secret = Utterance(
        org_id=org.id,
        capture_session_id=sessions[1].id,
        start_s=0,
        end_s=3,
        text="PRIVATE TRANSCRIPT CONTENT",
        asr_confidence=0.9,
        attribution_confidence=0,
    )
    db_session.add(secret)
    db_session.flush()
    db_session.add(
        KnowledgeEvidence(org_id=org.id, knowledge_item_id=claims[0].id, utterance_id=secret.id)
    )
    db_session.commit()
    actor(B)
    response = client.get(f"/api/v1/meetings/{sessions[0].id}/report")
    assert response.status_code == 200
    assert "PRIVATE TRANSCRIPT CONTENT" not in response.text
    assert response.json()["decisions"][0]["evidence"] == []
