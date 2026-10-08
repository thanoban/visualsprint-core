"""Bridge a finalized CaptureRequest into the main processing pipeline.

Called by the outbox worker for operation == "capture.ingest_provider_transcript".
Idempotent: if a CaptureSession already exists for the request it returns early.

Steps:
  1. Fetch final transcript from the Vexa provider.
  2. Create CaptureSession (mode="B") linked to the request's Meeting.
  3. Create Utterance rows from final provider segments.
  4. Detect coverage gaps → CoverageInterval rows.
  5. Update CaptureRequest.capture_session_id.
  6. Enqueue understanding directly; the English pilot collects no screen media.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import structlog
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.capture.dispatcher import CaptureProviderResolver
from app.db.models import (
    CaptureAttempt,
    CaptureAttemptState,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureSession,
    CaptureState,
    CoverageInterval,
    CoverageStatus,
    OutboxEvent,
    OutboxStatus,
    ProviderBinding,
    Utterance,
)
from app.interfaces.capture_provider import (
    CaptureProviderError,
    CaptureReference,
    CaptureStatus,
    TranscriptSegment,
)
from app.orchestrator.queue import enqueue_stage

log = structlog.get_logger()

# Pipeline entry point for provider-transcript sessions.
# acquire / diarize / identify / transcribe are all skipped.
_PROVIDER_TRANSCRIPT_ENTRY_STAGE = "understand"

# Segments below this confidence are flagged as DEGRADED coverage.
_DEGRADED_CONFIDENCE = 0.4


def _detect_gaps(segments: list[TranscriptSegment]) -> list[dict[str, object]]:
    """Return gap spans from provider segments (no ASR cascade involved)."""
    gaps: list[dict[str, object]] = []
    for seg in segments:
        if not seg.final or not seg.text.strip():
            gaps.append(
                dict(
                    start_s=seg.start_s,
                    end_s=seg.end_s,
                    status=CoverageStatus.MISSING,
                    reason="provider transcript not finalized for this span"
                    if not seg.final
                    else "provider returned no text for this span",
                )
            )
        elif seg.confidence is not None and seg.confidence < _DEGRADED_CONFIDENCE:
            gaps.append(
                dict(
                    start_s=seg.start_s,
                    end_s=seg.end_s,
                    status=CoverageStatus.DEGRADED,
                    reason=f"low provider confidence ({seg.confidence:.2f})",
                )
            )
    return gaps


async def ingest_next(
    session_factory: Callable[[], Session],
    *,
    provider_resolver: CaptureProviderResolver,
    worker_id: str,
    now: datetime | None = None,
    lease_seconds: int = 120,
) -> bool:
    """Claim and process one pending ingest event.  Returns True if an event was processed."""
    timestamp = now or datetime.now(UTC)
    stale = timestamp - timedelta(seconds=lease_seconds)

    with session_factory() as db:
        event = db.execute(
            select(OutboxEvent)
            .where(
                OutboxEvent.operation == "capture.ingest_provider_transcript",
                OutboxEvent.run_at <= timestamp,
                or_(
                    OutboxEvent.status == OutboxStatus.PENDING,
                    (OutboxEvent.status == OutboxStatus.RUNNING) & (OutboxEvent.locked_at < stale),
                ),
            )
            .with_for_update(skip_locked=True)
            .limit(1)
        ).scalar_one_or_none()
        if event is None:
            return False
        event.status = OutboxStatus.RUNNING
        event.locked_by = worker_id
        event.locked_at = timestamp
        event.attempts += 1
        event.fencing_version += 1
        event_id, fence, attempts = event.id, event.fencing_version, event.attempts
        db.commit()
        request_id = event.payload.get("capture_request_id")

    if not isinstance(request_id, str) or request_id != event.entity_id:
        _mark_error(session_factory, event_id, "invalid_ingest_payload", fence, worker_id)
        return True

    with session_factory() as db:
        request = db.get(CaptureRequest, request_id)
        if request is None:
            _mark_done(session_factory, event_id, fence, worker_id)
            return True

        # Idempotent: already ingested.
        if request.capture_session_id is not None:
            _mark_done(session_factory, event_id, fence, worker_id)
            return True

        if request.status != CaptureRequestStatus.FINALIZED:
            log.warning("ingest.skipped_not_finalized", request_id=request_id)
            _mark_error(session_factory, event_id, "request_not_finalized", fence, worker_id)
            return True

        attempt = db.execute(
            select(CaptureAttempt)
            .where(
                CaptureAttempt.request_id == request_id,
                CaptureAttempt.state == CaptureAttemptState.ENDED,
            )
            .order_by(CaptureAttempt.attempt_no.desc())
            .limit(1)
        ).scalar_one_or_none()
        if attempt is None:
            log.warning("ingest.no_ended_attempt", request_id=request_id)
            _mark_error(session_factory, event_id, "ended_attempt_missing", fence, worker_id)
            return True

        binding = db.get(ProviderBinding, attempt.provider_binding_id)
        if binding is None:
            _mark_error(session_factory, event_id, "provider_binding_missing", fence, worker_id)
            return True

        org_id = request.org_id
        meeting_id = request.meeting_id

    if not attempt.provider_record_id:
        _mark_error(session_factory, event_id, "provider_record_id_missing", fence, worker_id)
        return True
    reference = CaptureReference(
        provider=binding.provider,
        record_id=attempt.provider_record_id,
        platform=request.platform,
        native_meeting_id=request.native_meeting_id,
    )

    try:
        provider = await provider_resolver.resolve(binding)
        snapshot = await provider.transcript(reference)
        if snapshot.capture.reference != reference:
            raise CaptureProviderError("provider_transcript_identity_mismatch")
        if snapshot.capture.status != CaptureStatus.ENDED or not snapshot.segments:
            raise CaptureProviderError("final_transcript_unavailable", retryable=True)
    except CaptureProviderError as exc:
        log.error("ingest.transcript_fetch_failed", request_id=request_id, code=exc.code)
        if attempts >= 5 or not exc.retryable:
            _mark_error(session_factory, event_id, exc.code, fence, worker_id)
        else:
            _reschedule(session_factory, event_id, timestamp, 60, fence, worker_id)
        return True
    except Exception:
        # Keep provider/secret errors out of logs, and preserve a bounded retry.
        if attempts >= 5:
            _mark_error(
                session_factory, event_id, "transcript_ingest_unavailable", fence, worker_id
            )
        else:
            _reschedule(session_factory, event_id, timestamp, 60, fence, worker_id)
        return True

    segments = [s for s in snapshot.segments if s.final]
    if not any(s.text.strip() for s in segments):
        if attempts >= 5:
            _mark_error(session_factory, event_id, "final_transcript_unavailable", fence, worker_id)
        else:
            _reschedule(session_factory, event_id, timestamp, 60, fence, worker_id)
        return True

    with session_factory() as db:
        event_row = db.scalar(
            select(OutboxEvent).where(OutboxEvent.id == event_id).with_for_update()
        )
        if not _owns_event(event_row, fence, worker_id):
            return True
        request = db.scalar(
            select(CaptureRequest).where(CaptureRequest.id == request_id).with_for_update()
        )
        if request is None or request.capture_session_id is not None:
            assert event_row is not None
            event_row.status = OutboxStatus.DONE
            event_row.locked_by = None
            event_row.locked_at = None
            db.commit()
            return True
        session = CaptureSession(
            org_id=org_id,
            meeting_id=meeting_id,
            mode="B",
            state=CaptureState.ACQUIRED,
        )
        db.add(session)
        db.flush()

        for seg in segments:
            db.add(
                Utterance(
                    org_id=org_id,
                    capture_session_id=session.id,
                    start_s=seg.start_s,
                    end_s=seg.end_s,
                    text=seg.text,
                    lang_tags=[seg.language] if seg.language else [],
                    asr_confidence=seg.confidence,
                    attribution_confidence=0.0,
                    speaker_cluster_id=seg.speaker_label,
                    provider=f"{binding.provider}:transcript",
                )
            )

        for gap in _detect_gaps(snapshot.segments):
            db.add(
                CoverageInterval(
                    org_id=org_id,
                    capture_session_id=session.id,
                    start_s=gap["start_s"],
                    end_s=gap["end_s"],
                    modality="audio",
                    status=gap["status"],
                    reason=gap["reason"],
                )
            )

        request.capture_session_id = session.id
        enqueue_stage(db, org_id, session.id, _PROVIDER_TRANSCRIPT_ENTRY_STAGE)

        if event_row is not None:
            event_row.status = OutboxStatus.DONE
            event_row.locked_by = None
            event_row.locked_at = None

        log.info(
            "ingest.done",
            request_id=request_id,
            session_id=session.id,
            utterances=len(segments),
        )
        db.commit()

    return True


def enqueue_ingest(db: Session, request: CaptureRequest) -> None:
    """Enqueue a provider transcript ingest event for a just-finalized request.

    Uses (operation, entity_id, input_revision) uniqueness so a duplicate
    ENDED event from the provider never creates two ingest jobs.
    """
    existing = db.execute(
        select(OutboxEvent).where(
            OutboxEvent.operation == "capture.ingest_provider_transcript",
            OutboxEvent.entity_id == request.id,
            OutboxEvent.input_revision == request.input_hash,
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            OutboxEvent(
                org_id=request.org_id,
                operation="capture.ingest_provider_transcript",
                entity_id=request.id,
                input_revision=request.input_hash,
                payload={"capture_request_id": request.id},
            )
        )


# --- private helpers ---


def _owns_event(event: OutboxEvent | None, fence: int, worker_id: str) -> bool:
    return (
        event is not None
        and event.status == OutboxStatus.RUNNING
        and event.fencing_version == fence
        and event.locked_by == worker_id
    )


def _mark_done(
    session_factory: Callable[[], Session], event_id: str, fence: int, worker_id: str
) -> None:
    with session_factory() as db:
        ev = db.scalar(select(OutboxEvent).where(OutboxEvent.id == event_id).with_for_update())
        if _owns_event(ev, fence, worker_id):
            assert ev is not None
            ev.status = OutboxStatus.DONE
            ev.locked_by = None
            ev.locked_at = None
        db.commit()


def _mark_error(
    session_factory: Callable[[], Session], event_id: str, code: str, fence: int, worker_id: str
) -> None:
    with session_factory() as db:
        ev = db.scalar(select(OutboxEvent).where(OutboxEvent.id == event_id).with_for_update())
        if _owns_event(ev, fence, worker_id):
            assert ev is not None
            ev.status = OutboxStatus.FAILED
            ev.error_code = code
            ev.locked_by = None
            ev.locked_at = None
        db.commit()


def _reschedule(
    session_factory: Callable[[], Session],
    event_id: str,
    now: datetime,
    delay_seconds: int,
    fence: int,
    worker_id: str,
) -> None:
    with session_factory() as db:
        ev = db.scalar(select(OutboxEvent).where(OutboxEvent.id == event_id).with_for_update())
        if _owns_event(ev, fence, worker_id):
            assert ev is not None
            ev.status = OutboxStatus.PENDING
            ev.run_at = now + timedelta(seconds=delay_seconds)
            ev.locked_by = None
            ev.locked_at = None
        db.commit()
