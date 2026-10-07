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

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models import (
    CaptureRequest,
    CaptureRequestStatus,
    Meeting,
    OrgMember,
    OutboxEvent,
    UsageReservation,
)
from app.interfaces.capture_provider import MeetingTarget


class CaptureRequestConflict(ValueError):
    """The same idempotency key was reused for a different request."""


class CaptureRequestScopeError(ValueError):
    """The actor or meeting does not belong to the requested workspace."""


@dataclass(frozen=True)
class CaptureRequestResult:
    request: CaptureRequest
    created: bool


def _canonical_hash(
    *,
    meeting_id: str,
    requested_by: str,
    target: MeetingTarget,
    meeting_url_secret_ref: str,
    policy_snapshot: dict[str, Any],
    estimated_seconds: int,
) -> str:
    document = {
        "meeting_id": meeting_id,
        "requested_by": requested_by,
        "platform": target.platform,
        "native_meeting_id": target.native_meeting_id,
        "meeting_url_sha256": hashlib.sha256(target.meeting_url.encode()).hexdigest(),
        "meeting_url_secret_ref": meeting_url_secret_ref,
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

    input_hash = _canonical_hash(
        meeting_id=meeting_id,
        requested_by=requested_by,
        target=validated_target,
        meeting_url_secret_ref=meeting_url_secret_ref,
        policy_snapshot=policy_snapshot,
        estimated_seconds=estimated_seconds,
    )
    existing = _find_existing(db, org_id, idempotency_key)
    if existing is not None:
        if existing.input_hash != input_hash:
            raise CaptureRequestConflict("idempotency_key_payload_mismatch")
        return CaptureRequestResult(existing, created=False)

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
        expires_at=timestamp + timedelta(minutes=15),
    )
    outbox = OutboxEvent(
        org_id=org_id,
        operation="capture.dispatch",
        entity_id=request_id,
        input_revision=input_hash,
        payload={"capture_request_id": request_id},
        run_at=timestamp,
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
