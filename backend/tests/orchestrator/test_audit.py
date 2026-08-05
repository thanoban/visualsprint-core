"""Unit coverage for app.orchestrator.audit -- the minimal audit log helper.
No dedicated test existed; call sites (test_actions.py, test_data_rights.py)
only assert on the behavior they trigger, never on log_audit_event's own
contract (add-but-don't-commit, detail defaulting)."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import AuditLog, Org
from app.orchestrator.audit import log_audit_event


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


@pytest.fixture
def org(db) -> Org:
    org = Org(name="Acme")
    db.add(org)
    db.commit()
    return org


def test_records_actor_event_and_detail(db, org):
    entry = log_audit_event(
        db,
        org_id=org.id,
        actor="user:nimal",
        event="action_approved",
        detail={"action_id": "abc123", "kind": "task_create"},
    )

    db.commit()

    assert entry.org_id == org.id
    assert entry.actor == "user:nimal"
    assert entry.event == "action_approved"
    assert entry.detail == {"action_id": "abc123", "kind": "task_create"}


def test_detail_defaults_to_an_empty_dict(db, org):
    entry = log_audit_event(db, org_id=org.id, actor="worker", event="retention_purge")

    db.commit()

    assert entry.detail == {}


def test_does_not_commit_the_transaction_itself(db, org):
    log_audit_event(db, org_id=org.id, actor="worker", event="meeting_erasure_requested")

    # Caller owns the commit boundary -- a rollback before commit must leave
    # no row behind, proving this helper only added to the session.
    db.rollback()

    assert db.query(AuditLog).count() == 0
