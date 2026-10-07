"""Unit tests for the project/customer memory aggregation service."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    Base,
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
from app.memory.project_memory import (
    _revision_hash,
    latest_summary,
    rebuild_customer_memory,
    rebuild_project_memory,
)

USER_ID = "svc-user-0000-0000-0000-000000000001"


@pytest.fixture()
def engine():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture()
def session_factory(engine):
    factory = sessionmaker(bind=engine)
    return factory


@pytest.fixture()
def db(session_factory):
    s = session_factory()
    yield s
    s.close()


def _seed(db):
    org = Org(name="Svc Org")
    db.add(org)
    db.flush()
    user = User(id=USER_ID, email="user@example.com")
    db.add_all([user, OrgMember(org_id=org.id, user_id=USER_ID, role="owner")])
    db.commit()
    return org


def _project(db, org_id, name="P"):
    p = Project(org_id=org_id, name=name, visibility="private", status="active", version=1)
    db.add(p)
    db.flush()
    db.add(ProjectMember(org_id=org_id, project_id=p.id, user_id=USER_ID, role="owner"))
    db.flush()
    return p


def _assign_meeting(db, org_id, project_id, title="M"):
    m = Meeting(org_id=org_id, title=title, platform="zoom")
    db.add(m)
    db.flush()
    db.add(
        MeetingAssignment(
            org_id=org_id,
            meeting_id=m.id,
            project_id=project_id,
            assigned_by=USER_ID,
            source=MeetingAssignmentSource.MANUAL,
        )
    )
    db.flush()
    return m


def test_revision_hash_stable():
    h1 = _revision_hash(["a", "b", "c"])
    h2 = _revision_hash(["c", "a", "b"])
    assert h1 == h2
    assert len(h1) == 64


def test_revision_hash_changes_with_different_meetings():
    assert _revision_hash(["a"]) != _revision_hash(["b"])


def test_rebuild_project_memory_empty(session_factory, db):
    org = _seed(db)
    project = _project(db, org.id)
    db.commit()

    sv = rebuild_project_memory(session_factory, org.id, project.id)
    assert sv.state == SummaryState.READY
    assert sv.scope_kind == "project"
    assert sv.scope_id == project.id
    assert sv.source_meeting_ids == []
    assert "No meetings" in sv.structured_summary["context_summary"]


def test_rebuild_project_memory_idempotent(session_factory, db):
    org = _seed(db)
    project = _project(db, org.id)
    db.commit()

    sv1 = rebuild_project_memory(session_factory, org.id, project.id)
    sv2 = rebuild_project_memory(session_factory, org.id, project.id)
    assert sv1.id == sv2.id
    s = session_factory()
    count = s.query(SummaryVersion).filter_by(scope_kind="project", scope_id=project.id).count()
    s.close()
    assert count == 1


def test_rebuild_project_memory_new_version_after_assignment(session_factory, db):
    org = _seed(db)
    project = _project(db, org.id)
    db.commit()

    sv1 = rebuild_project_memory(session_factory, org.id, project.id)

    # Now assign a meeting — hash changes → new row
    _assign_meeting(db, org.id, project.id)
    db.commit()

    sv2 = rebuild_project_memory(session_factory, org.id, project.id)
    assert sv2.id != sv1.id
    assert len(sv2.source_meeting_ids) == 1


def test_rebuild_project_memory_with_knowledge_items(session_factory, db):
    org = _seed(db)
    project = _project(db, org.id)
    meeting = _assign_meeting(db, org.id, project.id)
    cs = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="B", state=CaptureState.DONE)
    db.add(cs)
    db.flush()
    ki = KnowledgeItem(
        org_id=org.id,
        capture_session_id=cs.id,
        type=KnowledgeType.DECISION,
        statement="Use Postgres.",
        lifecycle_state=LifecycleState.NEW,
        confidence=Confidence.VERIFIED,
    )
    db.add(ki)
    db.commit()

    sv = rebuild_project_memory(session_factory, org.id, project.id)
    assert len(sv.structured_summary["decisions"]) == 1
    assert sv.structured_summary["decisions"][0]["statement"] == "Use Postgres."


def test_rebuild_customer_memory_aggregates_projects(session_factory, db):
    org = _seed(db)
    customer = Customer(org_id=org.id, name="Acme", status="active", version=1)
    db.add(customer)
    db.flush()

    p1 = _project(db, org.id, "P1")
    p1.customer_id = customer.id
    p2 = _project(db, org.id, "P2")
    p2.customer_id = customer.id

    m1 = _assign_meeting(db, org.id, p1.id, "M1")
    m2 = _assign_meeting(db, org.id, p2.id, "M2")
    db.commit()

    sv = rebuild_customer_memory(session_factory, org.id, customer.id)
    assert sv.scope_kind == "customer"
    assert sv.scope_id == customer.id
    assert set(sv.source_meeting_ids) == {m1.id, m2.id}


def test_latest_summary_returns_none_when_empty(db):
    org = _seed(db)
    result = latest_summary(db, "project", "no-such-id")
    assert result is None
