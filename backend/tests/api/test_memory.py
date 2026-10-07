"""Tests for F09 project/customer memory endpoints."""

from app.auth import dependency as auth_dep
from app.db.models import (
    CaptureSession,
    CaptureState,
    Confidence,
    Customer,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Meeting,
    MeetingAssignment,
    MeetingAssignmentSource,
    Org,
    OrgMember,
    Project,
    ProjectMember,
    SummaryState,
    SummaryVersion,
    User,
)
from app.main import app

USER_1 = "mem-user-0000-0000-0000-000000000001"
USER_2 = "mem-user-0000-0000-0000-000000000002"


def _seed(db):
    org = Org(name="MemOrg")
    db.add(org)
    db.flush()
    db.add_all(
        [
            User(id=USER_1, email="founder@example.com"),
            User(id=USER_2, email="other@example.com"),
            OrgMember(org_id=org.id, user_id=USER_1, role="owner"),
            OrgMember(org_id=org.id, user_id=USER_2, role="member"),
        ]
    )
    db.commit()
    return org


def _as(user_id, email):
    app.dependency_overrides[auth_dep.get_current_user] = lambda: User(id=user_id, email=email)


def _make_project(db, org_id, owner_id, name="Test project"):
    p = Project(org_id=org_id, name=name, visibility="private", status="active", version=1)
    db.add(p)
    db.flush()
    db.add(ProjectMember(org_id=org_id, project_id=p.id, user_id=owner_id, role="owner"))
    db.flush()
    return p


def _make_meeting_assignment(db, org_id, project_id, owner_id, title="Sprint review"):
    m = Meeting(org_id=org_id, title=title, platform="zoom")
    db.add(m)
    db.flush()
    db.add(
        MeetingAssignment(
            org_id=org_id,
            meeting_id=m.id,
            project_id=project_id,
            assigned_by=owner_id,
            source=MeetingAssignmentSource.MANUAL,
        )
    )
    db.flush()
    return m


def _make_knowledge_item(db, org_id, session_id, ki_type, statement, confidence=Confidence.VERIFIED):
    ki = KnowledgeItem(
        org_id=org_id,
        capture_session_id=session_id,
        type=ki_type,
        statement=statement,
        lifecycle_state=LifecycleState.NEW,
        confidence=confidence,
    )
    db.add(ki)
    db.flush()
    return ki


# ---------------------------------------------------------------------------
# Project memory
# ---------------------------------------------------------------------------


def test_get_project_memory_empty_project(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _make_project(db_session, org.id, USER_1)
    db_session.commit()

    resp = client.get(f"/api/v2/workspaces/{org.id}/projects/{project.id}/memory")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["scope_kind"] == "project"
    assert body["scope_id"] == project.id
    assert body["state"] == "ready"
    assert body["structured_summary"]["decisions"] == []
    assert body["structured_summary"]["commitments"] == []


def test_get_project_memory_with_knowledge_items(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _make_project(db_session, org.id, USER_1)
    meeting = _make_meeting_assignment(db_session, org.id, project.id, USER_1)

    capture_session = CaptureSession(
        org_id=org.id,
        meeting_id=meeting.id,
        mode="B",
        state=CaptureState.DONE,
    )
    db_session.add(capture_session)
    db_session.flush()

    _make_knowledge_item(
        db_session, org.id, capture_session.id,
        KnowledgeType.DECISION, "We will use Postgres for storage."
    )
    _make_knowledge_item(
        db_session, org.id, capture_session.id,
        KnowledgeType.COMMITMENT, "Alice will write the migration by Friday."
    )
    db_session.commit()

    resp = client.get(f"/api/v2/workspaces/{org.id}/projects/{project.id}/memory")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["structured_summary"]["decisions"]) == 1
    assert len(body["structured_summary"]["commitments"]) == 1
    assert meeting.id in body["source_meeting_ids"]


def test_get_project_memory_excludes_unsupported_confidence(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _make_project(db_session, org.id, USER_1)
    meeting = _make_meeting_assignment(db_session, org.id, project.id, USER_1)

    capture_session = CaptureSession(
        org_id=org.id, meeting_id=meeting.id, mode="B", state=CaptureState.DONE
    )
    db_session.add(capture_session)
    db_session.flush()

    _make_knowledge_item(
        db_session, org.id, capture_session.id,
        KnowledgeType.DECISION, "Unsupported claim.",
        confidence=Confidence.UNSUPPORTED,
    )
    db_session.commit()

    resp = client.get(f"/api/v2/workspaces/{org.id}/projects/{project.id}/memory")
    assert resp.status_code == 200, resp.text
    assert resp.json()["structured_summary"]["decisions"] == []


def test_get_project_memory_idempotent_same_hash(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _make_project(db_session, org.id, USER_1)
    db_session.commit()

    resp1 = client.get(f"/api/v2/workspaces/{org.id}/projects/{project.id}/memory")
    resp2 = client.get(f"/api/v2/workspaces/{org.id}/projects/{project.id}/memory")
    assert resp1.status_code == 200
    assert resp2.status_code == 200
    # Same hash → same row returned, not duplicated
    assert resp1.json()["id"] == resp2.json()["id"]
    assert db_session.query(SummaryVersion).filter_by(
        scope_kind="project", scope_id=project.id
    ).count() == 1


def test_get_project_memory_404_for_non_member(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    project = _make_project(db_session, org.id, USER_1)
    db_session.commit()

    _as(USER_2, "other@example.com")
    resp = client.get(f"/api/v2/workspaces/{org.id}/projects/{project.id}/memory")
    assert resp.status_code == 404


def test_get_project_memory_404_unknown_project(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    db_session.commit()

    resp = client.get(f"/api/v2/workspaces/{org.id}/projects/does-not-exist/memory")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Customer memory
# ---------------------------------------------------------------------------


def test_get_customer_memory_no_projects(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    customer = Customer(org_id=org.id, name="Acme", status="active", version=1)
    db_session.add(customer)
    db_session.commit()

    resp = client.get(f"/api/v2/workspaces/{org.id}/customers/{customer.id}/memory")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["scope_kind"] == "customer"
    assert body["scope_id"] == customer.id
    assert body["state"] == "ready"
    assert body["source_meeting_ids"] == []


def test_get_customer_memory_aggregates_across_projects(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    customer = Customer(org_id=org.id, name="Acme", status="active", version=1)
    db_session.add(customer)
    db_session.flush()

    p1 = _make_project(db_session, org.id, USER_1, "Project A")
    p1.customer_id = customer.id
    p2 = _make_project(db_session, org.id, USER_1, "Project B")
    p2.customer_id = customer.id

    m1 = _make_meeting_assignment(db_session, org.id, p1.id, USER_1, "Meeting A")
    m2 = _make_meeting_assignment(db_session, org.id, p2.id, USER_1, "Meeting B")
    db_session.commit()

    resp = client.get(f"/api/v2/workspaces/{org.id}/customers/{customer.id}/memory")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    meeting_ids = set(body["source_meeting_ids"])
    assert m1.id in meeting_ids
    assert m2.id in meeting_ids


def test_get_customer_memory_404_unknown_customer(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    db_session.commit()

    resp = client.get(f"/api/v2/workspaces/{org.id}/customers/does-not-exist/memory")
    assert resp.status_code == 404
