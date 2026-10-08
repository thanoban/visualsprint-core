"""Transactional creation of durable capture intent.

This module does not call a capture provider. It records one authorized intent,
its usage reservation and a dispatch outbox event in the caller's transaction.
External I/O belongs to a leased dispatcher after the transaction commits.
"""

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models import (
    CaptureRequest,
    CaptureRequestStatus,
    Meeting,
    Org,
    OrgMember,
    OutboxEvent,
    UsageReservation,
    UsageReservationStatus,
)
from app.interfaces.capture_provider import MeetingTarget
from app.modules.projects.access import can_read_meeting


class CaptureRequestConflict(ValueError):
    """The same idempotency key was reused for a different request."""


class CaptureRequestScopeError(ValueError):
    """The actor or meeting does not belong to the requested workspace."""


class CapturePolicyError(ValueError):
    """Workspace capture has not been explicitly enabled and acknowledged."""


class CaptureMinuteLimitError(ValueError):
    """Creating this request would exceed the workspace's monthly capture-minute limit."""


@dataclass(frozen=True)
class CaptureRequestResult:
    request: CaptureRequest
    created: bool


def capture_request_input_hash(
    *,
    meeting_id: str,
    requested_by: str,
    target: MeetingTarget,
    policy_snapshot: dict[str, Any],
    estimated_seconds: int,
) -> str:
    document = {
        "meeting_id": meeting_id,
        "requested_by": requested_by,
        "platform": target.platform,
        "native_meeting_id": target.native_meeting_id,
        "meeting_url_sha256": hashlib.sha256(target.meeting_url.encode()).hexdigest(),
        "policy_snapshot": policy_snapshot,
        "estimated_seconds": estimated_seconds,
    }
    try:
        encoded = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    except (TypeError, ValueError) as exc:
        raise ValueError("policy_snapshot must contain JSON values") from exc
    return hashlib.sha256(encoded.encode()).hexdigest()


def _find_existing(db: Session, org_id: str, idempotency_key: str) -> CaptureRequest | None:
    return db.execute(
        select(CaptureRequest).where(
            CaptureRequest.org_id == org_id,
            CaptureRequest.idempotency_key == idempotency_key,
        )
    ).scalar_one_or_none()


def create_capture_request(
    db: Session,
    *,
    org_id: str,
    meeting_id: str,
    requested_by: str,
    idempotency_key: str,
    target: MeetingTarget,
    meeting_url_secret_ref: str,
    policy_snapshot: dict[str, Any],
    estimated_seconds: int,
    now: datetime | None = None,
    run_at: datetime | None = None,
) -> CaptureRequestResult:
    """Create capture intent without committing or performing provider I/O."""

    if not idempotency_key or idempotency_key != idempotency_key.strip():
        raise ValueError("idempotency_key must be non-empty without surrounding whitespace")
    if len(idempotency_key) > 255:
        raise ValueError("idempotency_key is too long")
    if not meeting_url_secret_ref or len(meeting_url_secret_ref) > 255:
        raise ValueError("meeting_url_secret_ref is required")
    if not 1 <= estimated_seconds <= 4 * 60 * 60:
        raise ValueError("estimated_seconds must be between 1 and 14400")
    validated_target = MeetingTarget.from_url(target.meeting_url)
    if validated_target != target:
        raise ValueError("meeting target identity does not match its URL")

    org = db.scalar(select(Org).where(Org.id == org_id).with_for_update())
    meeting_exists = db.execute(
        select(Meeting.id).where(Meeting.id == meeting_id, Meeting.org_id == org_id)
    ).scalar_one_or_none()
    member_exists = db.execute(
        select(OrgMember.id).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == requested_by,
        )
    ).scalar_one_or_none()
    if meeting_exists is None or member_exists is None:
        raise CaptureRequestScopeError("capture_request_scope_mismatch")
    meeting = db.get(Meeting, meeting_id)
    if meeting is not None and (
        (meeting.owner_user_id is not None and meeting.owner_user_id != requested_by)
        or (org is not None and org.pilot_features_enabled and meeting.owner_user_id is None)
        or not can_read_meeting(db, org_id, meeting_id, requested_by)
    ):
        raise CaptureRequestScopeError("capture_request_scope_mismatch")
    input_hash = capture_request_input_hash(
        meeting_id=meeting_id,
        requested_by=requested_by,
        target=validated_target,
        policy_snapshot=policy_snapshot,
        estimated_seconds=estimated_seconds,
    )
    existing = _find_existing(db, org_id, idempotency_key)
    if existing is not None:
        if existing.input_hash != input_hash:
            raise CaptureRequestConflict("idempotency_key_payload_mismatch")
        return CaptureRequestResult(existing, created=False)
    if org is None or org.capture_policy == "off" or org.disclosure_ack_at is None:
        raise CapturePolicyError("workspace_capture_not_enabled")

    # Capture-minute limit: sum current-month reserved seconds.
    # Reservations use the "bot_second" unit; limit is stored as minutes.
    if org.capture_monthly_minutes is not None:
        now_ts = now or datetime.now(UTC)
        month_start = now_ts.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        month_end = (month_start.replace(day=28) + timedelta(days=4)).replace(day=1)
        used_seconds_raw = db.execute(
            select(
                func.coalesce(
                    func.sum(
                        case(
                            (
                                UsageReservation.status == UsageReservationStatus.RECONCILED,
                                func.coalesce(
                                    UsageReservation.actual_quantity,
                                    UsageReservation.estimated_quantity,
                                ),
                            ),
                            else_=UsageReservation.estimated_quantity,
                        )
                    ),
                    0,
                )
            ).where(
                UsageReservation.org_id == org_id,
                UsageReservation.unit == "bot_second",
                UsageReservation.created_at >= month_start,
                UsageReservation.created_at < month_end,
                UsageReservation.status.in_(
                    {UsageReservationStatus.RESERVED, UsageReservationStatus.RECONCILED}
                ),
            )
        ).scalar_one()
        used_seconds = float(used_seconds_raw or 0)
        limit_seconds = org.capture_monthly_minutes * 60
        if used_seconds + estimated_seconds > limit_seconds:
            raise CaptureMinuteLimitError(
                f"would exceed monthly limit of {org.capture_monthly_minutes} minutes"
            )

    timestamp = now or datetime.now(UTC)
    request_id = str(uuid.uuid4())
    request = CaptureRequest(
        id=request_id,
        org_id=org_id,
        meeting_id=meeting_id,
        requested_by=requested_by,
        platform=validated_target.platform,
        native_meeting_id=validated_target.native_meeting_id,
        meeting_url_secret_ref=meeting_url_secret_ref,
        policy_snapshot=policy_snapshot,
        input_hash=input_hash,
        idempotency_key=idempotency_key,
        status=CaptureRequestStatus.QUEUED,
    )
    reservation = UsageReservation(
        org_id=org_id,
        request_id=request_id,
        unit="bot_second",
        estimated_quantity=Decimal(estimated_seconds),
        expires_at=(run_at or timestamp) + timedelta(seconds=estimated_seconds, minutes=15),
    )
    outbox = OutboxEvent(
        org_id=org_id,
        operation="capture.dispatch",
        entity_id=request_id,
        input_revision=input_hash,
        payload={"capture_request_id": request_id},
        run_at=run_at or timestamp,
    )
    try:
        with db.begin_nested():
            db.add_all([request, reservation, outbox])
            db.flush()
    except IntegrityError:
        # Another transaction may have won the unique org/key insert. Never
        # create a second external dispatch; resolve the durable row instead.
        existing = _find_existing(db, org_id, idempotency_key)
        if existing is None:
            raise
        if existing.input_hash != input_hash:
            raise CaptureRequestConflict("idempotency_key_payload_mismatch") from None
        return CaptureRequestResult(existing, created=False)
    return CaptureRequestResult(request, created=True)
