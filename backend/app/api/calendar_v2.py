"""Calendar occurrence list and per-event capture-override endpoints."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user, require_org_member
from app.db.base import get_db
from app.db.models import CalendarConnection, CalendarOccurrence, CalendarOccurrenceStatus, User
from app.modules.projects.access import can_edit_meeting, visible_meeting_ids

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["calendar-v2"])

_VALID_CAPTURE_OVERRIDES = {"on", "off"}


class OccurrenceView(BaseModel):
    id: str
    connection_id: str
    provider_event_id: str
    title: str
    start_time: str
    end_time: str
    platform: str | None
    status: str
    revision: int
    capture_override: str | None
    meeting_id: str | None


class SetCaptureOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capture_override: str | None = None


def _view(occ: CalendarOccurrence) -> OccurrenceView:
    return OccurrenceView(
        id=occ.id,
        connection_id=occ.connection_id,
        provider_event_id=occ.provider_event_id,
        title=occ.title,
        start_time=occ.start_time.isoformat(),
        end_time=occ.end_time.isoformat(),
        platform=occ.platform,
        status=occ.status.value,
        revision=occ.revision,
        capture_override=occ.capture_override,
        meeting_id=occ.meeting_id,
    )


@router.get("/occurrences", response_model=list[OccurrenceView])
def list_occurrences(
    org_id: str,
    days: int = 7,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[OccurrenceView]:
    if days < 1 or days > 90:
        raise HTTPException(422, "days must be between 1 and 90")
    cutoff = datetime.now(UTC) + timedelta(days=days)
    rows = (
        db.execute(
            select(CalendarOccurrence)
            .where(
                CalendarOccurrence.org_id == org_id,
                CalendarOccurrence.start_time >= datetime.now(UTC),
                CalendarOccurrence.start_time <= cutoff,
                CalendarOccurrence.status != CalendarOccurrenceStatus.CANCELLED,
                or_(
                    CalendarOccurrence.meeting_id.is_(None),
                    CalendarOccurrence.meeting_id.in_(visible_meeting_ids(org_id, _user.id)),
                ),
            )
            .order_by(CalendarOccurrence.start_time)
        )
        .scalars()
        .all()
    )
    return [_view(occ) for occ in rows]


@router.patch("/occurrences/{occurrence_id}/capture-override", response_model=OccurrenceView)
def set_capture_override(
    org_id: str,
    occurrence_id: str,
    body: SetCaptureOverride,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> OccurrenceView:
    if body.capture_override is not None and body.capture_override not in _VALID_CAPTURE_OVERRIDES:
        raise HTTPException(422, "capture_override must be 'on', 'off', or null")
    occurrence = db.execute(
        select(CalendarOccurrence).where(
            CalendarOccurrence.org_id == org_id,
            CalendarOccurrence.id == occurrence_id,
        )
    ).scalar_one_or_none()
    if occurrence is None:
        raise HTTPException(404, "occurrence not found")
    if occurrence.meeting_id and not can_edit_meeting(db, org_id, occurrence.meeting_id, user.id):
        raise HTTPException(404, "occurrence not found")
    occurrence.capture_override = body.capture_override
    db.commit()
    return _view(occurrence)


class ConnectionView(BaseModel):
    id: str
    provider: str
    account_email: str
    watch_healthy: bool
    watch_expires_at: str | None


@router.get("/connections", response_model=list[ConnectionView])
def list_calendar_connections(
    org_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[ConnectionView]:
    """Return connected calendar accounts and their health state."""
    connections = (
        db.execute(select(CalendarConnection).where(CalendarConnection.org_id == org_id))
        .scalars()
        .all()
    )
    now = datetime.now(UTC)
    return [
        ConnectionView(
            id=c.id,
            provider=c.provider,
            account_email=c.account_email,
            watch_healthy=c.watch_expires_at is not None and c.watch_expires_at > now,
            watch_expires_at=c.watch_expires_at.isoformat() if c.watch_expires_at else None,
        )
        for c in connections
    ]
