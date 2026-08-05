"""app/orchestrator/action_triggers.py's two deterministic triggers --
recurring-blocker escalation and approaching-due-date commitment reminders.
No LLM involved; pure DB-state fixtures."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import (
    ActionStatus,
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
from app.orchestrator.action_triggers import (
    propose_commitment_reminders,
    propose_recurring_blocker_escalations,
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


def _seed_session(db) -> tuple[str, str]:
    org = Org(name="acme")
    db.add(org)
    db.flush()
    meeting = Meeting(org_id=org.id, title="Standup", platform="upload")
    db.add(meeting)
    db.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.commit()
    return org.id, session.id


def _blocker(org_id, session_id, *, lifecycle_state) -> KnowledgeItem:
    item = KnowledgeItem(
        org_id=org_id,
        capture_session_id=session_id,
        type=KnowledgeType.BLOCKER,
        statement="CI pipeline still flaky",
        confidence=Confidence.VERIFIED,
        lifecycle_state=lifecycle_state,
    )
    return item


def test_recurring_blocker_gets_an_escalation_proposed(db):
    org_id, session_id = _seed_session(db)
    item = _blocker(org_id, session_id, lifecycle_state=LifecycleState.RECURRING)
    db.add(item)
    db.commit()

    created = propose_recurring_blocker_escalations(db, org_id)
    db.commit()

    assert len(created) == 1
    action = db.get(ProposedAction, created[0])
    assert action.kind == "escalation"
    assert action.status == ActionStatus.PENDING_APPROVAL
    assert action.payload["evidence_item_ids"] == [item.id]


def test_non_recurring_blocker_is_not_escalated(db):
    org_id, session_id = _seed_session(db)
    db.add(_blocker(org_id, session_id, lifecycle_state=LifecycleState.NEW))
    db.commit()

    created = propose_recurring_blocker_escalations(db, org_id)

    assert created == []


def test_resolved_recurring_blocker_is_not_escalated(db):
    # RESOLVED always wins even if a blocker was recurring at some point --
    # lifecycle_state is a single current value, not a history.
    org_id, session_id = _seed_session(db)
    db.add(_blocker(org_id, session_id, lifecycle_state=LifecycleState.RESOLVED))
    db.commit()

    created = propose_recurring_blocker_escalations(db, org_id)

    assert created == []


def test_a_recurring_blocker_is_only_escalated_once(db):
    org_id, session_id = _seed_session(db)
    db.add(_blocker(org_id, session_id, lifecycle_state=LifecycleState.RECURRING))
    db.commit()

    first = propose_recurring_blocker_escalations(db, org_id)
    db.commit()
    second = propose_recurring_blocker_escalations(db, org_id)
    db.commit()

    assert len(first) == 1
    assert second == []


def _commitment(org_id, session_id, owner_id, *, due_at, lifecycle_state=LifecycleState.NEW):
    return KnowledgeItem(
        org_id=org_id,
        capture_session_id=session_id,
        type=KnowledgeType.COMMITMENT,
        statement="Ship the migration plan",
        confidence=Confidence.VERIFIED,
        owner_person_id=owner_id,
        due_at=due_at,
        lifecycle_state=lifecycle_state,
    )


def test_commitment_due_soon_with_a_known_owner_gets_a_reminder(db):
    org_id, session_id = _seed_session(db)
    owner = Person(org_id=org_id, display_name="Nimal Perera", email="nimal@acme.test")
    db.add(owner)
    db.flush()
    now = datetime.now(UTC)
    item = _commitment(org_id, session_id, owner.id, due_at=now + timedelta(hours=2))
    db.add(item)
    db.commit()

    created = propose_commitment_reminders(db, org_id, within_hours=24.0, now=now)
    db.commit()

    assert len(created) == 1
    action = db.get(ProposedAction, created[0])
    assert action.kind == "reminder"
    assert action.payload["target"]["to"] == "nimal@acme.test"


def test_already_overdue_open_commitment_still_gets_a_reminder(db):
    org_id, session_id = _seed_session(db)
    owner = Person(org_id=org_id, display_name="Nimal Perera", email="nimal@acme.test")
    db.add(owner)
    db.flush()
    now = datetime.now(UTC)
    db.add(_commitment(org_id, session_id, owner.id, due_at=now - timedelta(days=3)))
    db.commit()

    created = propose_commitment_reminders(db, org_id, within_hours=24.0, now=now)

    assert len(created) == 1


def test_commitment_due_far_in_the_future_is_not_reminded_yet(db):
    org_id, session_id = _seed_session(db)
    owner = Person(org_id=org_id, display_name="Nimal Perera", email="nimal@acme.test")
    db.add(owner)
    db.flush()
    now = datetime.now(UTC)
    db.add(_commitment(org_id, session_id, owner.id, due_at=now + timedelta(days=30)))
    db.commit()

    created = propose_commitment_reminders(db, org_id, within_hours=24.0, now=now)

    assert created == []


def test_resolved_commitment_is_not_reminded(db):
    org_id, session_id = _seed_session(db)
    owner = Person(org_id=org_id, display_name="Nimal Perera", email="nimal@acme.test")
    db.add(owner)
    db.flush()
    now = datetime.now(UTC)
    db.add(
        _commitment(
            org_id,
            session_id,
            owner.id,
            due_at=now + timedelta(hours=1),
            lifecycle_state=LifecycleState.RESOLVED,
        )
    )
    db.commit()

    created = propose_commitment_reminders(db, org_id, within_hours=24.0, now=now)

    assert created == []


def test_commitment_with_no_owner_email_is_skipped(db):
    org_id, session_id = _seed_session(db)
    owner = Person(org_id=org_id, display_name="Nimal Perera", email=None)
    db.add(owner)
    db.flush()
    now = datetime.now(UTC)
    db.add(_commitment(org_id, session_id, owner.id, due_at=now + timedelta(hours=1)))
    db.commit()

    created = propose_commitment_reminders(db, org_id, within_hours=24.0, now=now)

    assert created == []


def test_commitment_with_no_owner_at_all_is_skipped(db):
    org_id, session_id = _seed_session(db)
    now = datetime.now(UTC)
    db.add(_commitment(org_id, session_id, None, due_at=now + timedelta(hours=1)))
    db.commit()

    created = propose_commitment_reminders(db, org_id, within_hours=24.0, now=now)

    assert created == []
