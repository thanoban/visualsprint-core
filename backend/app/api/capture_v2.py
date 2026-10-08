"""Authenticated v2 capture-request API.

Creating a request persists intent and an outbox event. It never calls the
provider inside the HTTP request and never exposes the invitation URL again.
"""

import base64
import binascii
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.adapters.secretstore_gcp import get_secretstore
from app.auth.dependency import get_current_user, require_org_member
from app.capture.commands import stop_capture
from app.capture.requests import (
    CaptureMinuteLimitError,
    CapturePolicyError,
    CaptureRequestConflict,
    CaptureRequestScopeError,
    capture_request_input_hash,
    create_capture_request,
)
from app.db.base import get_db
from app.db.models import (
    CalendarOccurrence,
    CaptureAttempt,
    CaptureRequest,
    CaptureSession,
    CaptureState,
    Meeting,
    Org,
    User,
)
from app.interfaces.capture_provider import MeetingTarget
from app.interfaces.secretstore import SecretStore
from app.modules.projects.access import can_read_meeting, visible_meeting_ids

_STALE_AFTER = timedelta(seconds=180)
_LIVE_STATES = {"joining", "waiting_for_admission", "capturing", "stopping"}

router = APIRouter(prefix="/api/v2/workspaces/{org_id}/capture-requests", tags=["capture-v2"])


def get_capture_secret_store() -> SecretStore:
    factory = cast(Callable[[], SecretStore], get_secretstore)
    return factory()


class CreateCaptureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    meeting_id: str = Field(min_length=1, max_length=36)
    meeting_url: str = Field(min_length=1, max_length=4096)
    estimated_seconds: int = Field(ge=1, le=14_400)
    policy: dict[str, Any] = Field(default_factory=dict)


class CaptureRequestView(BaseModel):
    id: str
    meeting_id: str
    platform: str
    native_meeting_id: str
    status: str
    stop_state: str
    version: int
    created: bool | None = None
    provider_state: str | None = None
    provider_status: str | None = None
    last_provider_contact_at: str | None = None
    last_transcript_at: str | None = None
    is_stale: bool = False
    error_code: str | None = None
    created_at: str
    title: str | None = None
    capture_session_id: str | None = None
    processing_state: str | None = None
    report_ready: bool = False


class CaptureRequestPage(BaseModel):
    items: list[CaptureRequestView]
    next_cursor: str | None


def _processing_session(db: Session, request: CaptureRequest) -> CaptureSession | None:
    if not request.capture_session_id:
        return None
    return db.scalar(
        select(CaptureSession).where(
            CaptureSession.id == request.capture_session_id,
            CaptureSession.org_id == request.org_id,
            CaptureSession.meeting_id == request.meeting_id,
        )
    )


def _view(
    request: CaptureRequest,
    *,
    attempt: CaptureAttempt | None = None,
    created: bool | None = None,
    session: CaptureSession | None = None,
    title: str | None = None,
) -> CaptureRequestView:
    now = datetime.now(UTC)
    is_stale = False
    if attempt and attempt.state.value in _LIVE_STATES and attempt.last_provider_contact_at:
        contact = attempt.last_provider_contact_at
        if contact.tzinfo is None:
            contact = contact.replace(tzinfo=UTC)
        is_stale = (now - contact) >= _STALE_AFTER
    return CaptureRequestView(
        id=request.id,
        meeting_id=request.meeting_id,
        platform=request.platform,
        native_meeting_id=request.native_meeting_id,
        status=request.status.value,
        stop_state=request.stop_state.value,
        version=request.version,
        created=created,
        provider_state=attempt.state.value if attempt else None,
        provider_status=attempt.provider_status if attempt else None,
        last_provider_contact_at=(
            attempt.last_provider_contact_at.isoformat()
            if attempt and attempt.last_provider_contact_at
            else None
        ),
        last_transcript_at=(
            attempt.last_transcript_at.isoformat()
            if attempt and attempt.last_transcript_at
            else None
        ),
        is_stale=is_stale,
        error_code=attempt.error_code if attempt else None,
        created_at=request.created_at.isoformat(),
        title=title,
        capture_session_id=session.id if session else None,
        processing_state=session.state.value if session else None,
        report_ready=session is not None and session.state == CaptureState.DONE,
    )


@router.post("", response_model=CaptureRequestView, status_code=status.HTTP_202_ACCEPTED)
async def create_request(
    org_id: str,
    body: CreateCaptureRequest,
    response: Response,
    idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=1, max_length=255),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
    secret_store: SecretStore = Depends(get_capture_secret_store),
) -> CaptureRequestView:
    try:
        target = MeetingTarget.from_url(body.meeting_url)
        input_hash = capture_request_input_hash(
            meeting_id=body.meeting_id,
            requested_by=user.id,
            target=target,
            policy_snapshot=body.policy,
            estimated_seconds=body.estimated_seconds,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    existing = db.execute(
        select(CaptureRequest).where(
            CaptureRequest.org_id == org_id,
            CaptureRequest.idempotency_key == idempotency_key,
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.input_hash != input_hash:
            raise HTTPException(409, "idempotency key was already used for another request")
        response.status_code = status.HTTP_200_OK
        return _view(existing, created=False)

    secret_ref = f"capture-url/{org_id}/{input_hash}"
    try:
        await secret_store.put(secret_ref, body.meeting_url)
        result = create_capture_request(
            db,
            org_id=org_id,
            meeting_id=body.meeting_id,
            requested_by=user.id,
            idempotency_key=idempotency_key,
            target=target,
            meeting_url_secret_ref=secret_ref,
            policy_snapshot=body.policy,
            estimated_seconds=body.estimated_seconds,
        )
        db.commit()
    except CaptureRequestConflict as exc:
        db.rollback()
        await secret_store.delete(secret_ref)
        raise HTTPException(409, "idempotency key was already used for another request") from exc
    except CaptureRequestScopeError as exc:
        db.rollback()
        await secret_store.delete(secret_ref)
        raise HTTPException(404, "meeting not found") from exc
    except CapturePolicyError as exc:
        db.rollback()
        await secret_store.delete(secret_ref)
        raise HTTPException(409, "workspace capture is not enabled") from exc
    except CaptureMinuteLimitError as exc:
        db.rollback()
        await secret_store.delete(secret_ref)
        raise HTTPException(429, str(exc)) from exc
    except Exception as exc:
        db.rollback()
        # Commit outcome can be ambiguous after a connection failure. Keep
        # the deterministic secret reference for reconciliation rather than
        # deleting a URL that a committed request may still require.
        raise HTTPException(503, "capture request could not be persisted") from exc
    if not result.created:
        response.status_code = status.HTTP_200_OK
    return _view(result.request, created=result.created)


@router.get("", response_model=CaptureRequestPage)
def list_requests(
    org_id: str,
    cursor: str | None = Query(default=None, max_length=512),
    limit: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> CaptureRequestPage:
    latest_attempt = (
        select(CaptureAttempt.id)
        .where(CaptureAttempt.request_id == CaptureRequest.id, CaptureAttempt.org_id == org_id)
        .order_by(CaptureAttempt.attempt_no.desc())
        .limit(1)
        .correlate(CaptureRequest)
        .scalar_subquery()
    )
    query = (
        select(CaptureRequest, CaptureAttempt, CaptureSession, Meeting.title)
        .join(Meeting, Meeting.id == CaptureRequest.meeting_id)
        .outerjoin(CaptureAttempt, CaptureAttempt.id == latest_attempt)
        .outerjoin(
            CaptureSession,
            and_(
                CaptureSession.id == CaptureRequest.capture_session_id,
                CaptureSession.org_id == org_id,
                CaptureSession.meeting_id == CaptureRequest.meeting_id,
            ),
        )
        .where(
            CaptureRequest.org_id == org_id,
            CaptureRequest.requested_by == user.id,
            CaptureRequest.meeting_id.in_(visible_meeting_ids(org_id, user.id)),
        )
    )
    if cursor:
        try:
            document = json.loads(base64.urlsafe_b64decode(cursor.encode()))
            timestamp = datetime.fromisoformat(document[0])
            identifier = str(UUID(document[1]))
            if timestamp.tzinfo is None:
                raise ValueError("missing timezone")
        except (ValueError, TypeError, KeyError, IndexError, binascii.Error) as exc:
            raise HTTPException(422, "invalid capture cursor") from exc
        query = query.where(
            or_(
                CaptureRequest.created_at < timestamp,
                and_(CaptureRequest.created_at == timestamp, CaptureRequest.id < identifier),
            )
        )
    rows = db.execute(
        query.order_by(CaptureRequest.created_at.desc(), CaptureRequest.id.desc()).limit(limit + 1)
    ).all()
    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1][0]
        timestamp = last.created_at
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=UTC)
        next_cursor = base64.urlsafe_b64encode(
            json.dumps([timestamp.isoformat(), last.id]).encode()
        ).decode()
    return CaptureRequestPage(
        items=[
            _view(request, attempt=attempt, session=session, title=title)
            for request, attempt, session, title in rows[:limit]
        ],
        next_cursor=next_cursor,
    )


@router.get("/{request_id}", response_model=CaptureRequestView)
def get_request(
    org_id: str,
    request_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> CaptureRequestView:
    request = db.execute(
        select(CaptureRequest).where(
            CaptureRequest.id == request_id,
            CaptureRequest.org_id == org_id,
        )
    ).scalar_one_or_none()
    if request is None:
        raise HTTPException(404, "capture request not found")
    if not can_read_meeting(db, org_id, request.meeting_id, user.id):
        raise HTTPException(404, "capture request not found")
    attempt = db.execute(
        select(CaptureAttempt)
        .where(CaptureAttempt.request_id == request.id)
        .order_by(CaptureAttempt.attempt_no.desc())
        .limit(1)
    ).scalar_one_or_none()
    session = _processing_session(db, request)
    meeting = db.get(Meeting, request.meeting_id)
    return _view(
        request, attempt=attempt, session=session, title=meeting.title if meeting else None
    )


@router.post("/{request_id}/stop", response_model=CaptureRequestView, status_code=202)
def stop_request(
    org_id: str,
    request_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> CaptureRequestView:
    db.scalar(select(Org.id).where(Org.id == org_id).with_for_update())
    request = db.execute(
        select(CaptureRequest)
        .where(CaptureRequest.id == request_id, CaptureRequest.org_id == org_id)
        .with_for_update()
    ).scalar_one_or_none()
    if request is None:
        raise HTTPException(404, "capture request not found")
    if request.requested_by != user.id or not can_read_meeting(
        db, org_id, request.meeting_id, user.id
    ):
        raise HTTPException(404, "capture request not found")
    occurrence_id = request.policy_snapshot.get("occurrence_id")
    if isinstance(occurrence_id, str):
        occurrence = db.get(CalendarOccurrence, occurrence_id)
        if (
            occurrence
            and occurrence.org_id == org_id
            and occurrence.meeting_id == request.meeting_id
        ):
            occurrence.capture_override = "off"
            occurrence.revision += 1
    attempt = stop_capture(db, request)
    db.commit()
    session = _processing_session(db, request)
    return _view(request, attempt=attempt, session=session)
