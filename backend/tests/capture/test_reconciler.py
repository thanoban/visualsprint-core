from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.capture.reconciler import (
    LOBBY_TIMEOUT_SECONDS,
    MAX_RUNTIME_SECONDS,
    reconcile_next,
)
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
from app.interfaces.capture_provider import (
    CaptureReference,
    CaptureSnapshot,
    CaptureStatus,
    TranscriptSegment,
    TranscriptSnapshot,
)


class Provider:
    def __init__(self, status, *, transcript_segments=None):
        self.status_value = status
        self.status_calls = 0
        self.stop_calls = 0
        self.transcript_calls = 0
        self._transcript_segments = transcript_segments or []

    async def status(self, reference):
        self.status_calls += 1
        return CaptureSnapshot(
            reference=reference, status=self.status_value, provider_status=self.status_value.value
        )

    async def transcript(self, reference):
        self.transcript_calls += 1
        snap = CaptureSnapshot(
            reference=reference, status=self.status_value, provider_status=self.status_value.value
        )
        return TranscriptSnapshot(capture=snap, segments=self._transcript_segments)

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


@pytest.mark.asyncio
async def test_transcript_freshness_updated_when_capturing_with_segments(state):
    with state() as db:
        db.get(CaptureAttempt, "attempt-1").state = CaptureAttemptState.CAPTURING
        db.commit()
    segment = TranscriptSegment(id="seg-1", start_s=0.0, end_s=2.5, text="Hello")
    provider = Provider(CaptureStatus.CAPTURING, transcript_segments=[segment])
    now = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    await reconcile_next(
        state,
        provider_resolver=Resolver(provider),
        worker_id="monitor-1",
        now=now,
    )
    with state() as db:
        attempt = db.get(CaptureAttempt, "attempt-1")
        # SQLite strips tzinfo; compare naive value
        assert attempt.last_transcript_at == now.replace(tzinfo=None)
        assert provider.transcript_calls == 1


@pytest.mark.asyncio
async def test_transcript_freshness_not_updated_when_no_segments(state):
    with state() as db:
        db.get(CaptureAttempt, "attempt-1").state = CaptureAttemptState.CAPTURING
        db.commit()
    provider = Provider(CaptureStatus.CAPTURING, transcript_segments=[])
    await reconcile_next(
        state,
        provider_resolver=Resolver(provider),
        worker_id="monitor-1",
        now=datetime(2026, 10, 8, tzinfo=UTC),
    )
    with state() as db:
        attempt = db.get(CaptureAttempt, "attempt-1")
        assert attempt.last_transcript_at is None


@pytest.mark.asyncio
async def test_transcript_not_polled_for_non_capturing_states(state):
    provider = Provider(CaptureStatus.WAITING)
    await reconcile_next(
        state,
        provider_resolver=Resolver(provider),
        worker_id="monitor-1",
        now=datetime(2026, 10, 8, tzinfo=UTC),
    )
    assert provider.transcript_calls == 0


@pytest.mark.asyncio
async def test_lobby_timeout_sets_stop_requested(state):
    now = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    entered = now - timedelta(seconds=LOBBY_TIMEOUT_SECONDS + 1)
    with state() as db:
        attempt = db.get(CaptureAttempt, "attempt-1")
        attempt.state = CaptureAttemptState.WAITING_FOR_ADMISSION
        attempt.state_entered_at = entered
        db.commit()
    provider = Provider(CaptureStatus.WAITING)
    await reconcile_next(
        state,
        provider_resolver=Resolver(provider),
        worker_id="monitor-1",
        now=now,
    )
    with state() as db:
        request = db.get(CaptureRequest, "request-1")
        assert request.stop_state == CaptureStopState.REQUESTED


@pytest.mark.asyncio
async def test_lobby_timeout_not_triggered_before_threshold(state):
    now = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    entered = now - timedelta(seconds=LOBBY_TIMEOUT_SECONDS - 60)
    with state() as db:
        attempt = db.get(CaptureAttempt, "attempt-1")
        attempt.state = CaptureAttemptState.WAITING_FOR_ADMISSION
        attempt.state_entered_at = entered
        db.commit()
    provider = Provider(CaptureStatus.WAITING)
    await reconcile_next(
        state,
        provider_resolver=Resolver(provider),
        worker_id="monitor-1",
        now=now,
    )
    with state() as db:
        request = db.get(CaptureRequest, "request-1")
        assert request.stop_state == CaptureStopState.NOT_REQUESTED


@pytest.mark.asyncio
async def test_max_runtime_sets_stop_requested(state):
    now = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    entered = now - timedelta(seconds=MAX_RUNTIME_SECONDS + 1)
    with state() as db:
        attempt = db.get(CaptureAttempt, "attempt-1")
        attempt.state = CaptureAttemptState.CAPTURING
        attempt.state_entered_at = entered
        db.commit()
    provider = Provider(CaptureStatus.CAPTURING)
    await reconcile_next(
        state,
        provider_resolver=Resolver(provider),
        worker_id="monitor-1",
        now=now,
    )
    with state() as db:
        request = db.get(CaptureRequest, "request-1")
        assert request.stop_state == CaptureStopState.REQUESTED


@pytest.mark.asyncio
async def test_state_entered_at_updated_on_state_change(state):
    now = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
    with state() as db:
        attempt = db.get(CaptureAttempt, "attempt-1")
        assert attempt.state == CaptureAttemptState.JOINING
    provider = Provider(CaptureStatus.CAPTURING)
    await reconcile_next(
        state,
        provider_resolver=Resolver(provider),
        worker_id="monitor-1",
        now=now,
    )
    with state() as db:
        attempt = db.get(CaptureAttempt, "attempt-1")
        assert attempt.state == CaptureAttemptState.CAPTURING
        assert attempt.state_entered_at == now.replace(tzinfo=None)


@pytest.mark.asyncio
async def test_state_entered_at_not_updated_when_state_unchanged(state):
    earlier = datetime(2026, 10, 7, tzinfo=UTC)
    with state() as db:
        attempt = db.get(CaptureAttempt, "attempt-1")
        attempt.state = CaptureAttemptState.CAPTURING
        attempt.state_entered_at = earlier
        db.commit()
    provider = Provider(CaptureStatus.CAPTURING)
    now = datetime(2026, 10, 8, tzinfo=UTC)
    await reconcile_next(
        state,
        provider_resolver=Resolver(provider),
        worker_id="monitor-1",
        now=now,
    )
    with state() as db:
        attempt = db.get(CaptureAttempt, "attempt-1")
        assert attempt.state_entered_at == earlier.replace(tzinfo=None)
