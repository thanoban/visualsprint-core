"""Founder intake: persist intent, not a bot inside an HTTP request."""

from collections.abc import Callable
from typing import cast

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters.secretstore_gcp import get_secretstore
from app.auth.dependency import get_current_user, require_org_member
from app.capture.requests import (
    CaptureMinuteLimitError,
    CapturePolicyError,
    CaptureRequestConflict,
    CaptureRequestScopeError,
)
from app.db.base import get_db
from app.db.models import Org, ProviderBinding, ProviderBindingStatus, User
from app.interfaces.secretstore import SecretStore
from app.modules.capture.intake import capture_meeting

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["founder-capture"])


def secrets() -> SecretStore:
    return cast(Callable[[], SecretStore], get_secretstore)()


class CaptureIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    meeting_url: str = Field(min_length=1, max_length=4096)
    title: str = Field(default="", max_length=255)
    project_id: str | None = Field(default=None, max_length=36)
    estimated_seconds: int = Field(default=3600, ge=1, le=14400)


class IntakeView(BaseModel):
    id: str
    meeting_id: str
    status: str
    created: bool


@router.post("/captures", response_model=IntakeView, status_code=202)
async def create_capture(
    org_id: str,
    body: CaptureIn,
    response: Response,
    key: str = Header(alias="Idempotency-Key", min_length=1, max_length=255),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
    store: SecretStore = Depends(secrets),
) -> IntakeView:
    try:
        result = await capture_meeting(
            db,
            store,
            org_id=org_id,
            actor_id=user.id,
            key=key,
            meeting_url=body.meeting_url,
            title=body.title,
            project_id=body.project_id,
            estimated_seconds=body.estimated_seconds,
        )
    except CaptureRequestConflict as exc:
        db.rollback()
        raise HTTPException(409, str(exc)) from exc
    except CaptureRequestScopeError as exc:
        db.rollback()
        raise HTTPException(404, str(exc)) from exc
    except CaptureMinuteLimitError as exc:
        db.rollback()
        raise HTTPException(429, str(exc)) from exc
    except CapturePolicyError as exc:
        db.rollback()
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    if not result.created:
        response.status_code = 200
    return IntakeView(
        id=result.request.id,
        meeting_id=result.request.meeting_id,
        status=result.request.status.value,
        created=result.created,
    )


@router.get("/capture-readiness")
def readiness(
    org_id: str, db: Session = Depends(get_db), _: None = Depends(require_org_member)
) -> dict[str, bool]:
    org = db.get(Org, org_id)
    if org is None:
        raise HTTPException(404, "workspace not found")
    bindings = db.scalars(
        select(ProviderBinding.id)
        .where(
            ProviderBinding.org_id == org_id,
            ProviderBinding.provider == "vexa",
            ProviderBinding.status == ProviderBindingStatus.ACTIVE,
        )
        .limit(2)
    ).all()
    return {
        "provider_configured": len(bindings) == 1,
        "manual_capture_enabled": org.capture_policy != "off" and org.disclosure_ack_at is not None,
        "automatic_capture_enabled": org.pilot_features_enabled
        and org.capture_policy == "calendar"
        and org.disclosure_ack_at is not None,
        "live_join_verified": False,
    }
