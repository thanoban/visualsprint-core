"""Calendar occurrence list and per-event capture-override endpoints."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user, require_org_member
from app.capture.commands import stop_capture
from app.db.base import get_db
from app.db.models import (
    CalendarConnection,
    CalendarOccurrence,
    CalendarOccurrenceStatus,
    CaptureRequest,
    CaptureRequestStatus,
    Org,
    User,
)
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
    capture_error: str | None = None


class SetCaptureOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capture_override: str | None = None
    version: int | None = None


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
        capture_error=occ.capture_error,
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
            .join(CalendarConnection, CalendarConnection.id == CalendarOccurrence.connection_id)
            .join(Org, Org.id == CalendarOccurrence.org_id)
            .where(
                CalendarOccurrence.org_id == org_id,
                CalendarConnection.enabled.is_(True),
                CalendarOccurrence.start_time >= datetime.now(UTC),
                CalendarOccurrence.start_time <= cutoff,
                CalendarOccurrence.status != CalendarOccurrenceStatus.CANCELLED,
                or_(
                    CalendarConnection.owner_user_id == _user.id,
                    and_(
                        CalendarConnection.owner_user_id.is_(None),
                        Org.pilot_features_enabled.is_(False),
                    ),
                ),
                or_(
                    CalendarOccurrence.meeting_id.is_(None),
                    CalendarOccurrence.meeting_id.in_(visible_meeting_ids(org_id, _user.id)),
                ),
            )
            .order_by(CalendarOccurrence.start_time, CalendarOccurrence.id)
            .limit(100)
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
    db.scalar(select(Org.id).where(Org.id == org_id).with_for_update())
    occurrence = db.execute(
        select(CalendarOccurrence)
        .where(CalendarOccurrence.org_id == org_id, CalendarOccurrence.id == occurrence_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if occurrence is None:
        raise HTTPException(404, "occurrence not found")
    connection = db.get(CalendarConnection, occurrence.connection_id)
    if (
        connection is None
        or not connection.enabled
        or (connection.owner_user_id is not None and connection.owner_user_id != user.id)
    ):
        raise HTTPException(404, "occurrence not found")
    org = db.get(Org, org_id)
    if connection.owner_user_id is None and org is not None and org.pilot_features_enabled:
        raise HTTPException(409, "reconnect the calendar to establish its owner")
    if body.version is not None and body.version != occurrence.revision:
        raise HTTPException(409, "occurrence changed; reload before updating capture")
    if occurrence.meeting_id and not can_edit_meeting(db, org_id, occurrence.meeting_id, user.id):
        raise HTTPException(404, "occurrence not found")
    if occurrence.capture_override != body.capture_override:
        occurrence.revision += 1
        occurrence.capture_override = body.capture_override
    if body.capture_override == "off" and occurrence.meeting_id:
        for request in db.scalars(
            select(CaptureRequest)
            .where(
                CaptureRequest.org_id == org_id,
                CaptureRequest.meeting_id == occurrence.meeting_id,
                CaptureRequest.status.not_in(
                    {
                        CaptureRequestStatus.CANCELLED,
                        CaptureRequestStatus.FAILED,
                        CaptureRequestStatus.FINALIZED,
                    }
                ),
            )
            .with_for_update()
        ):
            stop_capture(db, request)
    db.commit()
    return _view(occurrence)


class ConnectionView(BaseModel):
    id: str
    provider: str
    account_email: str
    watch_healthy: bool
    watch_expires_at: str | None
    owner_verified: bool = False


@router.get("/connections", response_model=list[ConnectionView])
def list_calendar_connections(
    org_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[ConnectionView]:
    """Return connected calendar accounts and their health state."""
    connections = (
        db.execute(
            select(CalendarConnection)
            .join(Org, Org.id == CalendarConnection.org_id)
            .where(
                CalendarConnection.org_id == org_id,
                CalendarConnection.enabled.is_(True),
                or_(
                    CalendarConnection.owner_user_id == _user.id,
                    and_(
                        CalendarConnection.owner_user_id.is_(None),
                        Org.pilot_features_enabled.is_(False),
                    ),
                ),
            )
            .limit(100)
        )
        .scalars()
        .all()
    )
    now = datetime.now(UTC)
    return [
        ConnectionView(
            id=c.id,
            provider=c.provider,
            account_email=c.account_email,
            watch_healthy=c.watch_expires_at is not None
            and c.watch_expires_at.replace(tzinfo=UTC) > now,
            watch_expires_at=c.watch_expires_at.isoformat() if c.watch_expires_at else None,
            owner_verified=c.owner_user_id == _user.id,
        )
        for c in connections
    ]
