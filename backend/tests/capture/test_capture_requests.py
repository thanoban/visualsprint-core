from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.capture.requests import (
    CaptureRequestConflict,
    CaptureRequestScopeError,
    create_capture_request,
)
from app.db.base import Base
from app.db.models import (
    CaptureRequest,
    Meeting,
    Org,
    OrgMember,
    OutboxEvent,
    ProviderBinding,
    UsageReservation,
    User,
)
from app.interfaces.capture_provider import MeetingTarget


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    session.add_all(
        [
            Org(
                id="org-1", name="One", capture_policy="manual",
                disclosure_ack_at=datetime(2026, 10, 7, tzinfo=UTC),
            ),
            Org(
                id="org-2", name="Two", capture_policy="manual",
                disclosure_ack_at=datetime(2026, 10, 7, tzinfo=UTC),
            ),
            User(id="user-1", email="one@example.com"),
            User(id="user-2", email="two@example.com"),
            OrgMember(org_id="org-1", user_id="user-1", role="owner"),
            OrgMember(org_id="org-2", user_id="user-2", role="owner"),
            Meeting(id="meeting-1", org_id="org-1", title="Pilot", platform="meet"),
            Meeting(id="meeting-2", org_id="org-2", title="Other", platform="meet"),
        ]
    )
    session.commit()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def create(db, **overrides):
    values = {
        "org_id": "org-1",
        "meeting_id": "meeting-1",
        "requested_by": "user-1",
        "idempotency_key": "client-request-1",
        "target": MeetingTarget.from_url(
            "https://meet.google.com/abc-defg-hij?authuser=1"
        ),
        "meeting_url_secret_ref": "secret://capture-url/one",
        "policy_snapshot": {"capture": True, "language": "en"},
        "estimated_seconds": 3600,
        "now": datetime(2026, 10, 7, tzinfo=UTC),
    }
    values.update(overrides)
    return create_capture_request(db, **values)


def test_create_persists_intent_reservation_and_outbox_atomically(db):
    result = create(db)
    db.commit()

    assert result.created
    request = db.get(CaptureRequest, result.request.id)
    assert request is not None
    assert request.org_id == "org-1"
    assert request.native_meeting_id == "abc-defg-hij"
    assert request.meeting_url_secret_ref == "secret://capture-url/one"
    assert len(request.input_hash) == 64

    reservation = db.execute(
        select(UsageReservation).where(UsageReservation.request_id == request.id)
    ).scalar_one()
    assert int(reservation.estimated_quantity) == 3600
    assert reservation.expires_at.replace(tzinfo=UTC) == datetime(
        2026, 10, 7, 0, 15, tzinfo=UTC
    )

    event = db.execute(
        select(OutboxEvent).where(OutboxEvent.entity_id == request.id)
    ).scalar_one()
    assert event.operation == "capture.dispatch"
    assert event.payload == {"capture_request_id": request.id}
    serialized = f"{request.__dict__!r}{event.payload!r}"
    assert "authuser=1" not in serialized
    assert "meet.google.com" not in serialized


def test_same_idempotency_key_and_payload_returns_one_request(db):
    first = create(db)
    second = create(db)

    assert first.created
    assert not second.created
    assert second.request.id == first.request.id
    assert db.scalar(select(func.count()).select_from(CaptureRequest)) == 1
    assert db.scalar(select(func.count()).select_from(UsageReservation)) == 1
    assert db.scalar(select(func.count()).select_from(OutboxEvent)) == 1


def test_idempotency_key_reuse_with_different_payload_conflicts(db):
    create(db)

    with pytest.raises(CaptureRequestConflict, match="payload_mismatch"):
        create(db, policy_snapshot={"capture": True, "language": "ta"})

    assert db.scalar(select(func.count()).select_from(CaptureRequest)) == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"meeting_id": "meeting-2"},
        {"requested_by": "user-2"},
        {"org_id": "org-2", "meeting_id": "meeting-1", "requested_by": "user-2"},
    ],
)
def test_cross_workspace_meeting_or_actor_is_rejected(db, changes):
    with pytest.raises(CaptureRequestScopeError, match="scope_mismatch"):
        create(db, **changes)

    assert db.scalar(select(func.count()).select_from(CaptureRequest)) == 0


@pytest.mark.parametrize("estimated_seconds", [0, 14401])
def test_duration_is_bounded_before_any_rows_are_written(db, estimated_seconds):
    with pytest.raises(ValueError, match="estimated_seconds"):
        create(db, estimated_seconds=estimated_seconds)
    assert db.scalar(select(func.count()).select_from(CaptureRequest)) == 0


def test_provider_account_scope_cannot_be_claimed_by_two_tenants(db):
    db.add(
        ProviderBinding(
            org_id="org-1",
            provider="vexa",
            endpoint_ref="config://vexa/primary",
            account_scope_id="provider-account-a",
            secret_ref="secret://vexa/org-1",
        )
    )
    db.commit()
    db.add(
        ProviderBinding(
            org_id="org-2",
            provider="vexa",
            endpoint_ref="config://vexa/primary",
            account_scope_id="provider-account-a",
            secret_ref="secret://vexa/org-2",
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
