"""Capture stop intent shared by HTTP commands and calendar cancellation."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    CaptureAttempt,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureStopState,
    OutboxEvent,
    OutboxStatus,
    UsageReservation,
    UsageReservationStatus,
)


def stop_capture(db: Session, request: CaptureRequest) -> CaptureAttempt | None:
    original = (request.status, request.stop_state)
    attempt = db.scalar(
        select(CaptureAttempt)
        .where(CaptureAttempt.request_id == request.id)
        .order_by(CaptureAttempt.attempt_no.desc())
        .limit(1)
    )
    if request.status in {
        CaptureRequestStatus.FINALIZED,
        CaptureRequestStatus.FAILED,
        CaptureRequestStatus.CANCELLED,
    }:
        request.stop_state = CaptureStopState.CONFIRMED
    elif attempt is None and request.status == CaptureRequestStatus.QUEUED:
        request.status = CaptureRequestStatus.CANCELLED
        request.stop_state = CaptureStopState.CONFIRMED
        for reservation in db.scalars(
            select(UsageReservation).where(
                UsageReservation.org_id == request.org_id,
                UsageReservation.request_id == request.id,
                UsageReservation.status == UsageReservationStatus.RESERVED,
            )
        ):
            reservation.status = UsageReservationStatus.RELEASED
        for event in db.scalars(
            select(OutboxEvent).where(
                OutboxEvent.entity_id == request.id,
                OutboxEvent.operation == "capture.dispatch",
                OutboxEvent.status.in_({OutboxStatus.PENDING, OutboxStatus.RUNNING}),
            )
        ):
            event.status = OutboxStatus.DONE
            event.locked_by = None
            event.locked_at = None
    else:
        from app.capture.dispatcher import enqueue_reconciliation

        if request.stop_state not in {CaptureStopState.REQUESTED, CaptureStopState.ACKNOWLEDGED}:
            request.stop_state = CaptureStopState.REQUESTED
        enqueue_reconciliation(db, request)
    if original != (request.status, request.stop_state):
        request.version += 1
    return attempt
