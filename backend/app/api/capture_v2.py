"""Authenticated v2 capture-request API.

Creating a request persists intent and an outbox event. It never calls the
provider inside the HTTP request and never exposes the invitation URL again.
"""

from collections.abc import Callable
from typing import Any, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters.secretstore_gcp import get_secretstore
from app.auth.dependency import get_current_user, require_org_member
from app.capture.dispatcher import enqueue_reconciliation
from app.capture.requests import (
    CapturePolicyError,
    CaptureRequestConflict,
    CaptureRequestScopeError,
    capture_request_input_hash,
    create_capture_request,
)
from app.db.base import get_db
from app.db.models import (
    CaptureAttempt,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureStopState,
    OutboxEvent,
    OutboxStatus,
    User,
)
from app.interfaces.capture_provider import MeetingTarget
from app.interfaces.secretstore import SecretStore

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
    error_code: str | None = None


def _view(
    request: CaptureRequest,
    *,
    attempt: CaptureAttempt | None = None,
    created: bool | None = None,
) -> CaptureRequestView:
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
        error_code=attempt.error_code if attempt else None,
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
    except Exception as exc:
        db.rollback()
        # Commit outcome can be ambiguous after a connection failure. Keep
        # the deterministic secret reference for reconciliation rather than
        # deleting a URL that a committed request may still require.
        raise HTTPException(503, "capture request could not be persisted") from exc
    if not result.created:
        response.status_code = status.HTTP_200_OK
    return _view(result.request, created=result.created)


@router.get("/{request_id}", response_model=CaptureRequestView)
def get_request(
    org_id: str,
    request_id: str,
    db: Session = Depends(get_db),
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
    attempt = db.execute(
        select(CaptureAttempt)
        .where(CaptureAttempt.request_id == request.id)
        .order_by(CaptureAttempt.attempt_no.desc())
        .limit(1)
    ).scalar_one_or_none()
    return _view(request, attempt=attempt)


@router.post("/{request_id}/stop", response_model=CaptureRequestView, status_code=202)
def stop_request(
    org_id: str,
    request_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> CaptureRequestView:
    request = db.execute(
        select(CaptureRequest)
        .where(CaptureRequest.id == request_id, CaptureRequest.org_id == org_id)
        .with_for_update()
    ).scalar_one_or_none()
    if request is None:
        raise HTTPException(404, "capture request not found")
    original_status = request.status
    original_stop_state = request.stop_state
    attempt = db.execute(
        select(CaptureAttempt)
        .where(CaptureAttempt.request_id == request.id)
        .order_by(CaptureAttempt.attempt_no.desc())
        .limit(1)
    ).scalar_one_or_none()
    if request.status in {CaptureRequestStatus.FINALIZED, CaptureRequestStatus.FAILED}:
        request.stop_state = CaptureStopState.CONFIRMED
    elif attempt is None and request.status == CaptureRequestStatus.QUEUED:
        request.status = CaptureRequestStatus.CANCELLED
        request.stop_state = CaptureStopState.CONFIRMED
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
    elif request.stop_state not in {
        CaptureStopState.REQUESTED,
        CaptureStopState.ACKNOWLEDGED,
    }:
        request.stop_state = CaptureStopState.REQUESTED
        enqueue_reconciliation(db, request)
    else:
        enqueue_reconciliation(db, request)
    if request.status != original_status or request.stop_state != original_stop_state:
        request.version += 1
    db.commit()
    return _view(request, attempt=attempt)
