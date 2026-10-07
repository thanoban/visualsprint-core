"""Workspace onboarding and capture policy endpoints."""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user, require_org_admin, require_org_member
from app.db.base import get_db
from app.db.models import Org, OrgMember, User

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["workspaces-v2"])


class WorkspaceView(BaseModel):
    id: str
    name: str
    role: str
    timezone: str
    preferred_language: str
    retention_days: int | None
    capture_policy: str
    capture_concurrency_limit: int
    capture_monthly_minutes: int
    disclosure_acknowledged: bool
    onboarding_complete: bool


class UpdateWorkspace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    preferred_language: str | None = None
    retention_days: int | None = Field(default=None, ge=1, le=3650)
    capture_policy: str | None = None
    capture_concurrency_limit: int | None = Field(default=None, ge=1, le=5)
    capture_monthly_minutes: int | None = Field(default=None, ge=60, le=6000)
    acknowledge_disclosure: bool = False


def _view(org: Org, role: str) -> WorkspaceView:
    acknowledged = org.disclosure_ack_at is not None
    return WorkspaceView(
        id=org.id,
        name=org.name,
        role=role,
        timezone=org.timezone,
        preferred_language=org.preferred_language,
        retention_days=org.retention_days,
        capture_policy=org.capture_policy,
        capture_concurrency_limit=org.capture_concurrency_limit,
        capture_monthly_minutes=org.capture_monthly_minutes,
        disclosure_acknowledged=acknowledged,
        onboarding_complete=org.capture_policy != "off" and acknowledged,
    )


@router.get("", response_model=WorkspaceView)
def get_workspace(
    org_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> WorkspaceView:
    org = db.get(Org, org_id)
    member = db.query(OrgMember).filter_by(org_id=org_id, user_id=user.id).one_or_none()
    if org is None or member is None:
        raise HTTPException(404, "workspace not found")
    return _view(org, member.role)


@router.patch("", response_model=WorkspaceView)
def update_workspace(
    org_id: str,
    body: UpdateWorkspace,
    db: Session = Depends(get_db),
    user: User = Depends(require_org_admin),
) -> WorkspaceView:
    org = db.get(Org, org_id)
    if org is None:
        raise HTTPException(404, "workspace not found")
    if body.timezone is not None:
        try:
            ZoneInfo(body.timezone)
        except ZoneInfoNotFoundError as exc:
            raise HTTPException(422, "unknown IANA timezone") from exc
        org.timezone = body.timezone
    if body.preferred_language is not None:
        if body.preferred_language != "en":
            raise HTTPException(422, "the current pilot supports English only")
        org.preferred_language = body.preferred_language
    if body.capture_policy is not None:
        if body.capture_policy not in {"off", "manual", "calendar"}:
            raise HTTPException(422, "capture_policy must be off, manual, or calendar")
        if body.capture_policy != "off" and not (
            body.acknowledge_disclosure or org.disclosure_ack_at is not None
        ):
            raise HTTPException(409, "disclosure acknowledgement is required before capture")
        org.capture_policy = body.capture_policy
    if body.acknowledge_disclosure and org.disclosure_ack_at is None:
        org.disclosure_ack_at = datetime.now(UTC)
        org.disclosure_ack_by = user.id
    for field in ("name", "retention_days", "capture_concurrency_limit", "capture_monthly_minutes"):
        if field in body.model_fields_set:
            value = getattr(body, field)
            if field == "name" and value is not None:
                value = value.strip()
                if not value:
                    raise HTTPException(422, "workspace name is required")
            setattr(org, field, value)
    db.commit()
    member = db.query(OrgMember).filter_by(org_id=org_id, user_id=user.id).one()
    return _view(org, member.role)
