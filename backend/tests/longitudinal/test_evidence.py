from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import (
    CaptureSession,
    Confidence,
    EdgeKind,
    KnowledgeEdge,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Meeting,
    Org,
    Person,
)
from app.longitudinal.evidence import assemble_person_evidence, detect_repetition_candidates


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _meeting_item(db, org, person, day, statement):
    meeting = Meeting(
        org_id=org.id,
        title=f"Standup {day}",
        scheduled_start=datetime(2026, 8, day, 9, tzinfo=UTC),
    )
    db.add(meeting)
    db.flush()
    capture = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(capture)
    db.flush()
    item = KnowledgeItem(
        org_id=org.id,
        capture_session_id=capture.id,
        owner_person_id=person.id,
        type=KnowledgeType.BLOCKER,
        statement=statement,
        confidence=Confidence.VERIFIED,
        lifecycle_state=LifecycleState.RECURRING,
    )
    db.add(item)
    db.flush()
    return item


def test_repetition_candidates_require_cross_session_similarity_and_no_block_link(db):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    person = Person(org_id=org.id, display_name="Nimal")
    db.add(person)
    db.flush()
    first = _meeting_item(db, org, person, 1, "Gateway vendor key is still missing")
    second = _meeting_item(db, org, person, 8, "Gateway vendor key is still missing")
    corpus = assemble_person_evidence(
        db,
        org.id,
        person.id,
        datetime(2026, 7, 1, tzinfo=UTC),
        datetime(2026, 9, 1, tzinfo=UTC),
    )

    candidates = detect_repetition_candidates(db, org.id, person.id, corpus)

    assert [[item.id for item in group] for group in candidates] == [[first.id, second.id]]

    commitment = _meeting_item(db, org, person, 9, "Gateway vendor key is still missing")
    db.add(
        KnowledgeEdge(
            org_id=org.id,
            from_item_id=second.id,
            to_item_id=commitment.id,
            kind=EdgeKind.BLOCKS,
            rationale="External key blocks progress.",
        )
    )
    db.flush()
    corpus = assemble_person_evidence(
        db,
        org.id,
        person.id,
        datetime.now(UTC) - timedelta(days=365),
        datetime.now(UTC) + timedelta(days=365),
    )
    candidates = detect_repetition_candidates(db, org.id, person.id, corpus)
    assert all(commitment.id not in {item.id for item in group} for group in candidates)
