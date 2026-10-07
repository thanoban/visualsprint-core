from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.capture.reconciler import reconcile_next
from app.db.base import Base
from app.db.models import (
    CaptureAttempt,
    CaptureAttemptState,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureStopState,
    Meeting,
    Org,
    OutboxEvent,
    OutboxStatus,
    ProviderBinding,
    User,
)
from app.interfaces.capture_provider import CaptureSnapshot, CaptureStatus


class Provider:
    def __init__(self, status):
        self.status_value = status
        self.status_calls = 0
        self.stop_calls = 0

    async def status(self, reference):
        self.status_calls += 1
        return CaptureSnapshot(
            reference=reference, status=self.status_value, provider_status=self.status_value.value
        )

    async def stop(self, reference):
        self.stop_calls += 1


class Resolver:
    def __init__(self, provider):
        self.provider = provider

    async def resolve(self, binding):
        return self.provider


@pytest.fixture
def state():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    Base.metadata.create_all(engine)
    with factory() as db:
        db.add_all(
            [
                Org(id="org-1", name="One"),
                User(id="user-1", email="one@example.com"),
                Meeting(id="meeting-1", org_id="org-1", title="Call", platform="meet"),
                ProviderBinding(
                    id="binding-1",
                    org_id="org-1",
                    provider="vexa",
                    endpoint_ref="endpoint",
                    account_scope_id="account",
                    secret_ref="key",
                ),
            ]
        )
        request = CaptureRequest(
            id="request-1",
            org_id="org-1",
            meeting_id="meeting-1",
            requested_by="user-1",
            platform="google_meet",
            native_meeting_id="abc-defg-hij",
            meeting_url_secret_ref="meeting-url",
            policy_snapshot={},
            input_hash="a" * 64,
            idempotency_key="key-1",
            status=CaptureRequestStatus.MONITORING,
        )
        db.add(request)
        db.add(
            CaptureAttempt(
                id="attempt-1",
                org_id="org-1",
                request_id="request-1",
                attempt_no=1,
                provider_binding_id="binding-1",
                provider_record_id="record-1",
                state=CaptureAttemptState.JOINING,
            )
        )
        db.add(
            OutboxEvent(
                id="event-1",
                org_id="org-1",
                operation="capture.reconcile",
                entity_id="request-1",
                input_revision="a" * 64,
                payload={"capture_request_id": "request-1"},
                run_at=datetime(2026, 10, 8, tzinfo=UTC),
            )
        )
        db.commit()
    try:
        yield factory
    finally:
        engine.dispose()


async def run(state, provider):
    return await reconcile_next(
        state,
        provider_resolver=Resolver(provider),
        worker_id="monitor-1",
        now=datetime(2026, 10, 8, tzinfo=UTC),
    )


@pytest.mark.asyncio
async def test_active_capture_is_refreshed_and_rescheduled(state):
    provider = Provider(CaptureStatus.CAPTURING)
    assert await run(state, provider)
    with state() as db:
        attempt = db.get(CaptureAttempt, "attempt-1")
        event = db.get(OutboxEvent, "event-1")
        assert attempt.state == CaptureAttemptState.CAPTURING
        assert event.status == OutboxStatus.PENDING
        assert event.locked_by is None


@pytest.mark.asyncio
async def test_ended_capture_finalizes_once(state):
    provider = Provider(CaptureStatus.ENDED)
    assert await run(state, provider)
    with state() as db:
        request = db.get(CaptureRequest, "request-1")
        event = db.get(OutboxEvent, "event-1")
        assert request.status == CaptureRequestStatus.FINALIZED
        assert event.status == OutboxStatus.DONE
    assert not await run(state, provider)
    assert provider.status_calls == 1


@pytest.mark.asyncio
async def test_stop_request_is_acknowledged_without_claiming_departure(state):
    with state() as db:
        db.get(CaptureRequest, "request-1").stop_state = CaptureStopState.REQUESTED
        db.commit()
    provider = Provider(CaptureStatus.CAPTURING)
    assert await run(state, provider)
    with state() as db:
        request = db.get(CaptureRequest, "request-1")
        assert request.stop_state == CaptureStopState.ACKNOWLEDGED
        assert request.status == CaptureRequestStatus.MONITORING
    assert provider.stop_calls == 1


@pytest.mark.asyncio
async def test_uncertain_attempt_without_record_id_requires_operator_reconciliation(state):
    with state() as db:
        db.get(CaptureAttempt, "attempt-1").provider_record_id = None
        db.commit()
    provider = Provider(CaptureStatus.CAPTURING)
    assert await run(state, provider)
    with state() as db:
        request = db.get(CaptureRequest, "request-1")
        event = db.get(OutboxEvent, "event-1")
        assert request.status == CaptureRequestStatus.RECONCILIATION_REQUIRED
        assert event.status == OutboxStatus.FAILED
        assert event.error_code == "provider_record_id_missing"
    assert provider.status_calls == 0


@pytest.mark.asyncio
async def test_ended_provider_confirms_requested_stop(state):
    with state() as db:
        db.get(CaptureRequest, "request-1").stop_state = CaptureStopState.REQUESTED
        db.commit()
    assert await run(state, Provider(CaptureStatus.ENDED))
    with state() as db:
        request = db.get(CaptureRequest, "request-1")
        assert request.stop_state == CaptureStopState.CONFIRMED
        assert request.status == CaptureRequestStatus.FINALIZED
