"""Tests for F10 persistent thread and message APIs."""

from app.auth import dependency as auth_dep
from app.db.models import (
    ChatMessage,
    Customer,
    MessageRole,
    MessageState,
    Org,
    OrgMember,
    Project,
    ProjectMember,
    User,
)
from app.main import app

USER_1 = "thr-user-0000-0000-0000-000000000001"
USER_2 = "thr-user-0000-0000-0000-000000000002"


def _seed(db):
    org = Org(name="ThreadOrg")
    db.add(org)
    db.flush()
    db.add_all(
        [
            User(id=USER_1, email="founder@example.com"),
            User(id=USER_2, email="other@example.com"),
        ]
    )
    db.flush()
    db.add_all(
        [
            OrgMember(org_id=org.id, user_id=USER_1, role="owner"),
            OrgMember(org_id=org.id, user_id=USER_2, role="member"),
        ]
    )
    db.commit()
    return org


def _as(user_id, email):
    app.dependency_overrides[auth_dep.get_current_user] = lambda: User(id=user_id, email=email)


def _project(db, org_id, owner_id, name="P"):
    p = Project(org_id=org_id, name=name, visibility="private", status="active", version=1)
    db.add(p)
    db.flush()
    db.add(ProjectMember(org_id=org_id, project_id=p.id, user_id=owner_id, role="owner"))
    db.flush()
    return p


def _customer(db, org_id, name="Acme"):
    c = Customer(org_id=org_id, name=name, status="active", version=1)
    db.add(c)
    db.flush()
    return c


# ---------------------------------------------------------------------------
# Thread CRUD
# ---------------------------------------------------------------------------


def test_create_project_thread(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _project(db_session, org.id, USER_1)
    db_session.commit()

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": project.id, "title": "Q4 planning"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["scope_kind"] == "project"
    assert body["scope_id"] == project.id
    assert body["title"] == "Q4 planning"
    assert body["status"] == "active"
    assert body["version"] == 1


def test_create_customer_thread(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    customer = _customer(db_session, org.id)
    db_session.commit()

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "customer", "scope_id": customer.id, "title": "Acme history"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["scope_kind"] == "customer"


def test_create_thread_non_project_member_denied(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _project(db_session, org.id, USER_1)
    db_session.commit()

    _as(USER_2, "other@example.com")
    resp = client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": project.id, "title": "Blocked"},
    )
    assert resp.status_code == 404


def test_create_thread_unknown_project_is_404(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    db_session.commit()

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": "does-not-exist", "title": "X"},
    )
    assert resp.status_code == 404


def test_list_threads_returns_only_creators(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _project(db_session, org.id, USER_1)
    db_session.commit()

    client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": project.id, "title": "T1"},
    )
    _as(USER_2, "other@example.com")
    # USER_2 is org member but not project member; list shows nothing
    threads = client.get(f"/api/v2/workspaces/{org.id}/threads").json()
    assert threads == []


def test_list_threads_scope_filter(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _project(db_session, org.id, USER_1)
    customer = _customer(db_session, org.id)
    db_session.commit()

    client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": project.id, "title": "ProjThread"},
    )
    client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "customer", "scope_id": customer.id, "title": "CustThread"},
    )

    proj_threads = client.get(
        f"/api/v2/workspaces/{org.id}/threads",
        params={"scope_kind": "project", "scope_id": project.id},
    ).json()
    assert len(proj_threads) == 1
    assert proj_threads[0]["title"] == "ProjThread"


def test_update_thread_title_and_archive(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _project(db_session, org.id, USER_1)
    db_session.commit()

    created = client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": project.id, "title": "Old"},
    ).json()

    updated = client.patch(
        f"/api/v2/workspaces/{org.id}/threads/{created['id']}",
        json={"version": 1, "title": "New title"},
    )
    assert updated.status_code == 200
    assert updated.json()["title"] == "New title"
    assert updated.json()["version"] == 2

    archived = client.patch(
        f"/api/v2/workspaces/{org.id}/threads/{created['id']}",
        json={"version": 2, "status": "archived"},
    )
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"


def test_update_thread_version_conflict(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _project(db_session, org.id, USER_1)
    db_session.commit()

    created = client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": project.id, "title": "T"},
    ).json()

    client.patch(
        f"/api/v2/workspaces/{org.id}/threads/{created['id']}",
        json={"version": 1, "title": "First"},
    )
    stale = client.patch(
        f"/api/v2/workspaces/{org.id}/threads/{created['id']}",
        json={"version": 1, "title": "Stale"},
    )
    assert stale.status_code == 409


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------


def test_send_message_creates_user_and_pending_assistant(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _project(db_session, org.id, USER_1)
    db_session.commit()

    thread = client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": project.id, "title": "T"},
    ).json()

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/threads/{thread['id']}/messages",
        json={"text": "Why are we using MongoDB?", "client_request_id": "a" * 36},
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["role"] == "user"
    assert body["content"] == "Why are we using MongoDB?"

    # Should have user + pending assistant in DB
    msgs = db_session.query(ChatMessage).filter_by(thread_id=thread["id"]).all()
    assert len(msgs) == 2
    roles = {m.role for m in msgs}
    assert MessageRole.USER in roles
    assert MessageRole.ASSISTANT in roles
    assistant = next(m for m in msgs if m.role == MessageRole.ASSISTANT)
    assert assistant.state == MessageState.PENDING
    assert assistant.generation_id is not None


def test_send_message_idempotent(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _project(db_session, org.id, USER_1)
    db_session.commit()

    thread = client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": project.id, "title": "T"},
    ).json()

    client_req_id = "b" * 36
    resp1 = client.post(
        f"/api/v2/workspaces/{org.id}/threads/{thread['id']}/messages",
        json={"text": "Hello", "client_request_id": client_req_id},
    )
    resp2 = client.post(
        f"/api/v2/workspaces/{org.id}/threads/{thread['id']}/messages",
        json={"text": "Hello", "client_request_id": client_req_id},
    )
    assert resp1.status_code == 202
    assert resp2.status_code == 202
    assert resp1.json()["id"] == resp2.json()["id"]
    # Only one user msg created
    user_msgs = (
        db_session.query(ChatMessage).filter_by(thread_id=thread["id"], role=MessageRole.USER).all()
    )
    assert len(user_msgs) == 1


def test_send_message_to_archived_thread_rejected(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _project(db_session, org.id, USER_1)
    db_session.commit()

    thread = client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": project.id, "title": "T"},
    ).json()
    client.patch(
        f"/api/v2/workspaces/{org.id}/threads/{thread['id']}",
        json={"version": 1, "status": "archived"},
    )

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/threads/{thread['id']}/messages",
        json={"text": "Hello", "client_request_id": "c" * 36},
    )
    assert resp.status_code == 409


def test_list_messages_returns_chronological_order(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _project(db_session, org.id, USER_1)
    db_session.commit()

    thread = client.post(
        f"/api/v2/workspaces/{org.id}/threads",
        json={"scope_kind": "project", "scope_id": project.id, "title": "T"},
    ).json()
    client.post(
        f"/api/v2/workspaces/{org.id}/threads/{thread['id']}/messages",
        json={"text": "First question", "client_request_id": "d" * 36},
    )

    msgs = client.get(f"/api/v2/workspaces/{org.id}/threads/{thread['id']}/messages").json()
    assert len(msgs) >= 2
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"] == "First question"
