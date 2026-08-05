"""Worker-level periodic action-trigger sweep (worker.py's
_run_action_triggers). action_triggers.py's own trigger logic is covered
by tests/orchestrator/test_action_triggers.py -- this proves the periodic
*caller* worker.py adds: it iterates every org, commits on success, and
one org's failure doesn't stop the rest."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.orchestrator.worker as worker
from app.db.base import Base
from app.db.models import (
    CaptureSession,
    Confidence,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Meeting,
    Org,
    Person,
    ProposedAction,
)


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


def _seed_recurring_blocker(db, name: str) -> Org:
    org = Org(name=name)
    db.add(org)
    db.flush()
    meeting = Meeting(org_id=org.id, title="Standup", platform="upload")
    db.add(meeting)
    db.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()
    db.add(
        KnowledgeItem(
            org_id=org.id,
            capture_session_id=session.id,
            type=KnowledgeType.BLOCKER,
            statement="Recurring blocker",
            confidence=Confidence.VERIFIED,
            lifecycle_state=LifecycleState.RECURRING,
        )
    )
    db.commit()
    return org


async def test_a_recurring_blocker_across_two_orgs_both_get_escalated(db):
    org_a = _seed_recurring_blocker(db, "org-a")
    org_b = _seed_recurring_blocker(db, "org-b")

    await worker._run_action_triggers(db)

    for org in (org_a, org_b):
        actions = db.query(ProposedAction).filter(ProposedAction.org_id == org.id).all()
        assert len(actions) == 1
        assert actions[0].kind == "escalation"


async def test_one_orgs_failure_does_not_block_the_other(db, monkeypatch):
    org_a = _seed_recurring_blocker(db, "org-a")
    org_b = _seed_recurring_blocker(db, "org-b")

    import app.orchestrator.action_triggers as triggers

    original = triggers.propose_recurring_blocker_escalations

    def failing_or_real(db_arg, org_id):
        if org_id == org_a.id:
            raise RuntimeError("boom")
        return original(db_arg, org_id)

    monkeypatch.setattr(triggers, "propose_recurring_blocker_escalations", failing_or_real)

    await worker._run_action_triggers(db)  # must not raise

    assert db.query(ProposedAction).filter(ProposedAction.org_id == org_a.id).count() == 0
    assert db.query(ProposedAction).filter(ProposedAction.org_id == org_b.id).count() == 1


async def test_commitment_reminder_uses_the_configured_window(db, monkeypatch):
    org = Org(name="acme")
    db.add(org)
    db.flush()
    meeting = Meeting(org_id=org.id, title="Standup", platform="upload")
    db.add(meeting)
    db.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()
    owner = Person(org_id=org.id, display_name="Nimal Perera", email="nimal@acme.test")
    db.add(owner)
    db.flush()
    db.add(
        KnowledgeItem(
            org_id=org.id,
            capture_session_id=session.id,
            type=KnowledgeType.COMMITMENT,
            statement="Ship the plan",
            confidence=Confidence.VERIFIED,
            owner_person_id=owner.id,
            due_at=datetime.now(UTC) + timedelta(hours=1),
        )
    )
    db.commit()

    await worker._run_action_triggers(db)

    actions = db.query(ProposedAction).filter(ProposedAction.org_id == org.id).all()
    assert len(actions) == 1
    assert actions[0].kind == "reminder"
