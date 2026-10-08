"""Poll provider state for accepted or uncertain capture attempts."""

import hashlib
import json
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.capture.dispatcher import CaptureProviderResolver
from app.db.models import (
    CaptureAttempt,
    CaptureAttemptState,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureStopState,
    OutboxEvent,
    OutboxStatus,
    ProviderBinding,
)
from app.interfaces.capture_provider import (
    CaptureProviderError,
    CaptureReference,
    CaptureStatus,
    TranscriptSnapshot,
)

# Automatic stop thresholds enforced by the reconciler.
LOBBY_TIMEOUT_SECONDS = 600  # 10 minutes in WAITING_FOR_ADMISSION before auto-stop
MAX_RUNTIME_SECONDS = 14_400  # 4-hour hard cap (matches estimated_seconds max)

_STATE_MAP = {
    CaptureStatus.SCHEDULED: CaptureAttemptState.SCHEDULED,
    CaptureStatus.JOINING: CaptureAttemptState.JOINING,
    CaptureStatus.WAITING: CaptureAttemptState.WAITING_FOR_ADMISSION,
    CaptureStatus.BLOCKED: CaptureAttemptState.BLOCKED,
    CaptureStatus.CAPTURING: CaptureAttemptState.CAPTURING,
    CaptureStatus.STOPPING: CaptureAttemptState.STOPPING,
    CaptureStatus.ENDED: CaptureAttemptState.ENDED,
    CaptureStatus.FAILED: CaptureAttemptState.FAILED,
    CaptureStatus.UNKNOWN: CaptureAttemptState.UNKNOWN,
}


async def reconcile_next(
    session_factory: Callable[[], Session],
    *,
    provider_resolver: CaptureProviderResolver,
    worker_id: str,
    now: datetime | None = None,
    poll_seconds: int = 15,
    lease_seconds: int = 60,
) -> bool:
    timestamp = now or datetime.now(UTC)
    with session_factory() as db:
        stale = timestamp - timedelta(seconds=lease_seconds)
        event = db.execute(
            select(OutboxEvent)
            .where(
                OutboxEvent.operation == "capture.reconcile",
                OutboxEvent.run_at <= timestamp,
                or_(
                    OutboxEvent.status == OutboxStatus.PENDING,
                    (OutboxEvent.status == OutboxStatus.RUNNING) & (OutboxEvent.locked_at < stale),
                ),
            )
            .order_by(OutboxEvent.run_at, OutboxEvent.created_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        ).scalar_one_or_none()
        if event is None:
            return False
        event.status = OutboxStatus.RUNNING
        event.attempts += 1
        event.locked_by = worker_id
        event.locked_at = timestamp
        event.fencing_version += 1
        event_id, fence, request_id = event.id, event.fencing_version, event.entity_id
        db.commit()

    with session_factory() as db:
        request = db.get(CaptureRequest, request_id)
        attempt = db.execute(
            select(CaptureAttempt)
            .where(CaptureAttempt.request_id == request_id)
            .order_by(CaptureAttempt.attempt_no.desc())
            .limit(1)
        ).scalar_one_or_none()
        if request is None or attempt is None or attempt.provider_record_id is None:
            event = db.scalar(
                select(OutboxEvent).where(OutboxEvent.id == event_id).with_for_update()
            )
            if _owns_event(event, fence, worker_id):
                assert event is not None
                event.status = OutboxStatus.FAILED
                event.error_code = "provider_record_id_missing"
                event.locked_by = None
                event.locked_at = None
                if request is not None:
                    request.status = CaptureRequestStatus.RECONCILIATION_REQUIRED
                db.commit()
            return True
        binding = db.get(ProviderBinding, attempt.provider_binding_id)
        if binding is None:
            event = db.scalar(
                select(OutboxEvent).where(OutboxEvent.id == event_id).with_for_update()
            )
            if _owns_event(event, fence, worker_id):
                assert event is not None
                event.status = OutboxStatus.FAILED
                event.error_code = "provider_binding_missing"
                event.locked_by = None
                event.locked_at = None
                request.status = CaptureRequestStatus.RECONCILIATION_REQUIRED
                db.commit()
            return True
        reference = CaptureReference(
            provider=binding.provider,
            record_id=attempt.provider_record_id,
            platform=request.platform,
            native_meeting_id=request.native_meeting_id,
        )
        stop_requested = request.stop_state == CaptureStopState.REQUESTED

    try:
        provider = await provider_resolver.resolve(binding)
        snapshot = await provider.status(reference)
        if snapshot.reference != reference:
            raise CaptureProviderError("provider_status_identity_mismatch")
        transcript_snapshot = None
        if snapshot.status == CaptureStatus.CAPTURING:
            with suppress(CaptureProviderError):
                transcript_snapshot = await provider.transcript(reference)
                if transcript_snapshot.capture.reference != reference:
                    transcript_snapshot = None
        stop_sent = False
        if stop_requested and snapshot.status not in {CaptureStatus.ENDED, CaptureStatus.FAILED}:
            await provider.stop(reference)
            stop_sent = True
    except CaptureProviderError as exc:
        with session_factory() as db:
            event = db.scalar(
                select(OutboxEvent).where(OutboxEvent.id == event_id).with_for_update()
            )
            request = db.get(CaptureRequest, request_id)
            attempt = db.execute(
                select(CaptureAttempt)
                .where(CaptureAttempt.request_id == request_id)
                .order_by(CaptureAttempt.attempt_no.desc())
                .limit(1)
            ).scalar_one_or_none()
            if not _owns_event(event, fence, worker_id) or request is None:
                return True
            assert event is not None
            event.error_code = exc.code
            event.locked_by = None
            event.locked_at = None
            if exc.retryable and event.attempts < event.max_attempts:
                event.status = OutboxStatus.PENDING
                event.run_at = timestamp + timedelta(seconds=poll_seconds)
            else:
                event.status = OutboxStatus.FAILED
                request.status = CaptureRequestStatus.RECONCILIATION_REQUIRED
                if attempt is not None:
                    attempt.error_code = exc.code
            db.commit()
        return True
    except (KeyError, ValueError):
        with session_factory() as db:
            event = db.scalar(
                select(OutboxEvent).where(OutboxEvent.id == event_id).with_for_update()
            )
            request = db.get(CaptureRequest, request_id)
            if _owns_event(event, fence, worker_id) and request is not None:
                assert event is not None
                event.status = OutboxStatus.FAILED
                event.error_code = "capture_reconciliation_configuration_error"
                event.locked_by = None
                event.locked_at = None
                request.status = CaptureRequestStatus.RECONCILIATION_REQUIRED
                db.commit()
        return True
    except Exception:
        with session_factory() as db:
            event = db.scalar(
                select(OutboxEvent).where(OutboxEvent.id == event_id).with_for_update()
            )
            request = db.get(CaptureRequest, request_id)
            if _owns_event(event, fence, worker_id) and request is not None:
                assert event is not None
                event.error_code = "capture_reconciliation_unavailable"
                event.locked_by = None
                event.locked_at = None
                if event.attempts < event.max_attempts:
                    event.status = OutboxStatus.PENDING
                    event.run_at = timestamp + timedelta(seconds=poll_seconds)
                else:
                    event.status = OutboxStatus.FAILED
                    request.status = CaptureRequestStatus.RECONCILIATION_REQUIRED
                db.commit()
        return True

    with session_factory() as db:
        event = db.scalar(select(OutboxEvent).where(OutboxEvent.id == event_id).with_for_update())
        request = db.scalar(
            select(CaptureRequest).where(CaptureRequest.id == request_id).with_for_update()
        )
        attempt = db.execute(
            select(CaptureAttempt)
            .where(CaptureAttempt.request_id == request_id)
            .order_by(CaptureAttempt.attempt_no.desc())
            .limit(1)
            .with_for_update()
        ).scalar_one_or_none()
        if (
            event is None
            or request is None
            or attempt is None
            or event.fencing_version != fence
            or event.locked_by != worker_id
            or event.status != OutboxStatus.RUNNING
        ):
            return True
        if attempt.state in {CaptureAttemptState.ENDED, CaptureAttemptState.FAILED}:
            # A late/stale snapshot cannot resurrect a terminal capture.
            event.status = OutboxStatus.DONE
            event.locked_by = None
            event.locked_at = None
            db.commit()
            return True
        new_state = _STATE_MAP[snapshot.status]
        if new_state != attempt.state:
            attempt.state_entered_at = timestamp
        attempt.state = new_state
        attempt.provider_status = snapshot.provider_status
        attempt.last_provider_contact_at = timestamp
        if transcript_snapshot and transcript_snapshot.segments:
            revision = _transcript_revision(transcript_snapshot)
            if revision != attempt.transcript_revision_hash:
                attempt.transcript_revision_hash = revision
                attempt.last_transcript_at = timestamp
        event.locked_by = None
        event.locked_at = None
        event.error_code = None
        # This event is reused for the whole call. Successful polls must not
        # consume the consecutive failure budget of a later provider outage.
        event.attempts = 0

        # Enforce automatic stop thresholds before committing state.
        _check_timeouts(request, attempt, timestamp, stop_requested)

        # Advance stop_state: confirm when terminal, acknowledge when stop was sent.
        if stop_requested and snapshot.status in {CaptureStatus.ENDED, CaptureStatus.FAILED}:
            request.stop_state = CaptureStopState.CONFIRMED
        elif stop_sent:
            request.stop_state = CaptureStopState.ACKNOWLEDGED
        # else: timeout just fired (stop_state is now REQUESTED); advance next cycle.
        if snapshot.status == CaptureStatus.ENDED:
            request.status = CaptureRequestStatus.FINALIZED
            event.status = OutboxStatus.DONE
            from app.capture.transcript_bridge import enqueue_ingest

            enqueue_ingest(db, request)
        elif snapshot.status == CaptureStatus.FAILED:
            request.status = CaptureRequestStatus.FAILED
            event.status = OutboxStatus.DONE
        else:
            request.status = CaptureRequestStatus.MONITORING
            event.status = OutboxStatus.PENDING
            event.run_at = timestamp + timedelta(seconds=poll_seconds)
        db.commit()
    return True


def _transcript_revision(snapshot: TranscriptSnapshot) -> str:
    segments = [s.model_dump(mode="json") for s in snapshot.segments]
    segments.sort(key=lambda s: (s["start_s"], s["end_s"], s["id"]))
    return hashlib.sha256(
        json.dumps(segments, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _owns_event(event: OutboxEvent | None, fence: int, worker_id: str) -> bool:
    return (
        event is not None
        and event.status == OutboxStatus.RUNNING
        and event.fencing_version == fence
        and event.locked_by == worker_id
    )


def _check_timeouts(
    request: CaptureRequest,
    attempt: CaptureAttempt,
    now: datetime,
    stop_already_requested: bool,
) -> None:
    """Raise stop_state to REQUESTED when automatic thresholds are exceeded."""
    if stop_already_requested or request.stop_state in {
        CaptureStopState.REQUESTED,
        CaptureStopState.ACKNOWLEDGED,
        CaptureStopState.CONFIRMED,
    }:
        return
    entered = attempt.state_entered_at
    if entered is None:
        return
    # SQLite (used in tests) stores datetimes as naive; normalize before comparing.
    if entered.tzinfo is None:
        entered = entered.replace(tzinfo=UTC)
    now_utc = now if now.tzinfo is not None else now.replace(tzinfo=UTC)
    elapsed = (now_utc - entered).total_seconds()
    if (
        attempt.state == CaptureAttemptState.WAITING_FOR_ADMISSION
        and elapsed >= LOBBY_TIMEOUT_SECONDS
    ):
        request.stop_state = CaptureStopState.REQUESTED
        request.version += 1
        return
    created = attempt.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    runtime = (now_utc - min(created, entered)).total_seconds()
    if attempt.state == CaptureAttemptState.CAPTURING and runtime >= MAX_RUNTIME_SECONDS:
        request.stop_state = CaptureStopState.REQUESTED
        request.version += 1
