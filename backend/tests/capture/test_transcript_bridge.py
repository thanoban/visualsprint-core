"""Tests for the F06 provider transcript ingest bridge."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.capture.transcript_bridge import enqueue_ingest, ingest_next
from app.db.base import Base
from app.db.models import (
    CaptureAttempt,
    CaptureAttemptState,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureSession,
    CaptureStopState,
    CoverageInterval,
    CoverageStatus,
    Meeting,
    Org,
    OutboxEvent,
    OutboxStatus,
    PipelineJob,
    ProviderBinding,
    ProviderBindingStatus,
    Utterance,
    User,
)
from app.interfaces.capture_provider import (
    CaptureProviderError,
    CaptureReference,
    CaptureSnapshot,
    CaptureStatus,
    TranscriptSegment,
    TranscriptSnapshot,
)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        session.add(Org(id="org-1", name="Acme"))
        session.add(User(id="user-1", email="u@example.com"))
        session.add(Meeting(id="meeting-1", org_id="org-1", title="Call", platform="meet"))
        session.add(
            ProviderBinding(
                id="binding-1",
                org_id="org-1",
                provider="vexa",
                endpoint_ref="https://vexa.example.com",
                account_scope_id="scope-1",
                secret_ref="secret-1",
                status=ProviderBindingStatus.ACTIVE,
            )
        )
        session.commit()
    try:
        yield factory
    finally:
        engine.dispose()


def _make_request(db, *, request_id: str = "req-1", status: CaptureRequestStatus = CaptureRequestStatus.FINALIZED) -> None:
    with db() as session:
        session.add(
            CaptureRequest(
                id=request_id,
                org_id="org-1",
                meeting_id="meeting-1",
                requested_by="user-1",
                platform="google_meet",
                native_meeting_id="abc-defg-hij",
                meeting_url_secret_ref="secret-url",
                policy_snapshot={},
                input_hash="a" * 64,
                idempotency_key=f"key-{request_id}",
                status=status,
            )
        )
        session.add(
            CaptureAttempt(
                id=f"attempt-{request_id}",
                org_id="org-1",
                request_id=request_id,
                attempt_no=1,
                provider_binding_id="binding-1",
                provider_record_id="vexa-rec-1",
                state=CaptureAttemptState.ENDED,
            )
        )
        session.commit()


def _add_ingest_event(db, request_id: str = "req-1") -> str:
    with db() as session:
        req = session.get(CaptureRequest, request_id)
        assert req is not None
        enqueue_ingest(session, req)
        session.commit()
        ev = session.execute(
            select(OutboxEvent).where(
                OutboxEvent.operation == "capture.ingest_provider_transcript",
                OutboxEvent.entity_id == request_id,
            )
        ).scalar_one()
        return ev.id


def _make_snapshot(segments: list[TranscriptSegment]) -> TranscriptSnapshot:
    snap = CaptureSnapshot(
        reference=CaptureReference(
            provider="vexa",
            record_id="vexa-rec-1",
            platform="google_meet",
            native_meeting_id="abc-defg-hij",
        ),
        status=CaptureStatus.ENDED,
        provider_status="ended",
    )
    return TranscriptSnapshot(capture=snap, segments=segments)


class FakeProvider:
    def __init__(self, *, segments: list[TranscriptSegment] | None = None, error: str | None = None):
        self._segments = segments or []
        self._error = error

    async def transcript(self, reference: CaptureReference) -> TranscriptSnapshot:
        if self._error:
            raise CaptureProviderError(self._error, retryable=False)
        return _make_snapshot(self._segments)

    async def start(self, target: Any) -> Any: ...
    async def status(self, reference: Any) -> Any: ...
    async def stop(self, reference: Any) -> None: ...
    async def delete_artifacts(self, reference: Any) -> None: ...


class FakeResolver:
    def __init__(self, provider: FakeProvider):
        self._provider = provider

    async def resolve(self, binding: Any) -> FakeProvider:
        return self._provider


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #


def test_enqueue_ingest_creates_outbox_event(db):
    _make_request(db)
    _add_ingest_event(db)
    with db() as session:
        ev = session.execute(
            select(OutboxEvent).where(
                OutboxEvent.operation == "capture.ingest_provider_transcript"
            )
        ).scalar_one()
        assert ev.entity_id == "req-1"
        assert ev.status == OutboxStatus.PENDING


def test_enqueue_ingest_is_idempotent(db):
    _make_request(db)
    with db() as session:
        req = session.get(CaptureRequest, "req-1")
        enqueue_ingest(session, req)
        enqueue_ingest(session, req)  # second call must not insert a duplicate
        session.commit()
    with db() as session:
        rows = session.execute(
            select(OutboxEvent).where(
                OutboxEvent.operation == "capture.ingest_provider_transcript"
            )
        ).scalars().all()
        assert len(rows) == 1


@pytest.mark.asyncio
async def test_ingest_creates_capture_session_and_utterances(db):
    _make_request(db)
    _add_ingest_event(db)
    segments = [
        TranscriptSegment(id="s1", start_s=0.0, end_s=5.0, text="Hello world", final=True, speaker_label="Speaker A", confidence=0.95),
        TranscriptSegment(id="s2", start_s=5.0, end_s=10.0, text="How are you", final=True, speaker_label="Speaker B", confidence=0.90),
    ]
    resolver = FakeResolver(FakeProvider(segments=segments))

    did = await ingest_next(db, provider_resolver=resolver, worker_id="w1")

    assert did is True
    with db() as session:
        req = session.get(CaptureRequest, "req-1")
        assert req.capture_session_id is not None
        cap_session = session.get(CaptureSession, req.capture_session_id)
        assert cap_session is not None
        assert cap_session.mode == "B"
        utterances = session.execute(
            select(Utterance).where(Utterance.capture_session_id == cap_session.id)
        ).scalars().all()
        assert len(utterances) == 2
        assert {u.text for u in utterances} == {"Hello world", "How are you"}
        assert utterances[0].speaker_cluster_id in {"Speaker A", "Speaker B"}


@pytest.mark.asyncio
async def test_ingest_enqueues_pipeline_at_screen_stage(db):
    _make_request(db)
    _add_ingest_event(db)
    segments = [
        TranscriptSegment(id="s1", start_s=0.0, end_s=3.0, text="Hi there", final=True, confidence=0.9),
    ]
    resolver = FakeResolver(FakeProvider(segments=segments))

    await ingest_next(db, provider_resolver=resolver, worker_id="w1")

    with db() as session:
        req = session.get(CaptureRequest, "req-1")
        job = session.execute(
            select(PipelineJob).where(PipelineJob.capture_session_id == req.capture_session_id)
        ).scalar_one_or_none()
        assert job is not None
        assert job.stage == "screen"


@pytest.mark.asyncio
async def test_ingest_skips_non_final_segments(db):
    _make_request(db)
    _add_ingest_event(db)
    segments = [
        TranscriptSegment(id="s1", start_s=0.0, end_s=3.0, text="Draft text", final=False),
        TranscriptSegment(id="s2", start_s=3.0, end_s=6.0, text="Final text", final=True, confidence=0.9),
    ]
    resolver = FakeResolver(FakeProvider(segments=segments))

    await ingest_next(db, provider_resolver=resolver, worker_id="w1")

    with db() as session:
        req = session.get(CaptureRequest, "req-1")
        utterances = session.execute(
            select(Utterance).where(Utterance.capture_session_id == req.capture_session_id)
        ).scalars().all()
        assert len(utterances) == 1
        assert utterances[0].text == "Final text"


@pytest.mark.asyncio
async def test_ingest_creates_coverage_gap_for_empty_segment(db):
    _make_request(db)
    _add_ingest_event(db)
    segments = [
        TranscriptSegment(id="s1", start_s=0.0, end_s=3.0, text="Hello", final=True, confidence=0.9),
        TranscriptSegment(id="s2", start_s=3.0, end_s=7.0, text="", final=True),
    ]
    resolver = FakeResolver(FakeProvider(segments=segments))

    await ingest_next(db, provider_resolver=resolver, worker_id="w1")

    with db() as session:
        req = session.get(CaptureRequest, "req-1")
        gaps = session.execute(
            select(CoverageInterval).where(
                CoverageInterval.capture_session_id == req.capture_session_id
            )
        ).scalars().all()
        assert len(gaps) == 1
        assert gaps[0].status == CoverageStatus.MISSING


@pytest.mark.asyncio
async def test_ingest_creates_degraded_gap_for_low_confidence(db):
    _make_request(db)
    _add_ingest_event(db)
    segments = [
        TranscriptSegment(id="s1", start_s=0.0, end_s=5.0, text="Mumble something", final=True, confidence=0.2),
    ]
    resolver = FakeResolver(FakeProvider(segments=segments))

    await ingest_next(db, provider_resolver=resolver, worker_id="w1")

    with db() as session:
        req = session.get(CaptureRequest, "req-1")
        gaps = session.execute(
            select(CoverageInterval).where(
                CoverageInterval.capture_session_id == req.capture_session_id
            )
        ).scalars().all()
        assert len(gaps) == 1
        assert gaps[0].status == CoverageStatus.DEGRADED


@pytest.mark.asyncio
async def test_ingest_is_idempotent_after_session_created(db):
    _make_request(db)
    _add_ingest_event(db)
    segments = [
        TranscriptSegment(id="s1", start_s=0.0, end_s=3.0, text="Hello", final=True, confidence=0.9),
    ]
    resolver = FakeResolver(FakeProvider(segments=segments))

    await ingest_next(db, provider_resolver=resolver, worker_id="w1")

    # Enqueue a second ingest event (as if the outbox fired again).
    with db() as session:
        req = session.get(CaptureRequest, "req-1")
        req.input_hash = "b" * 64  # different revision to bypass unique constraint
        enqueue_ingest(session, req)
        session.commit()

    sessions_before = 0
    with db() as session:
        sessions_before = session.execute(
            select(CaptureSession)
        ).scalars().all().__len__()

    await ingest_next(db, provider_resolver=resolver, worker_id="w1")

    with db() as session:
        sessions_after = session.execute(
            select(CaptureSession)
        ).scalars().all().__len__()
        assert sessions_after == sessions_before  # no second session created


@pytest.mark.asyncio
async def test_ingest_retries_on_provider_error(db):
    _make_request(db)
    _add_ingest_event(db)
    resolver = FakeResolver(FakeProvider(error="TRANSCRIPT_UNAVAILABLE"))

    did = await ingest_next(db, provider_resolver=resolver, worker_id="w1")

    assert did is True
    with db() as session:
        ev = session.execute(
            select(OutboxEvent).where(
                OutboxEvent.operation == "capture.ingest_provider_transcript"
            )
        ).scalar_one()
        assert ev.status == OutboxStatus.PENDING  # rescheduled, not failed
        assert ev.attempts == 1


@pytest.mark.asyncio
async def test_ingest_marks_failed_after_max_attempts(db):
    _make_request(db)
    with db() as session:
        req = session.get(CaptureRequest, "req-1")
        enqueue_ingest(session, req)
        ev = session.execute(
            select(OutboxEvent).where(
                OutboxEvent.operation == "capture.ingest_provider_transcript"
            )
        ).scalar_one()
        ev.attempts = 4  # will become 5 after this call
        session.commit()

    resolver = FakeResolver(FakeProvider(error="TRANSCRIPT_UNAVAILABLE"))
    await ingest_next(db, provider_resolver=resolver, worker_id="w1")

    with db() as session:
        ev = session.execute(
            select(OutboxEvent).where(
                OutboxEvent.operation == "capture.ingest_provider_transcript"
            )
        ).scalar_one()
        assert ev.status == OutboxStatus.FAILED
