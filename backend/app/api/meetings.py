"""Org-scoped meeting index.

Gives the product a stable place to browse past and scheduled meetings instead
of relying on deep links into report pages. The report and correction pages are
already keyed by capture_session_id; this index is the missing bridge from a
human-facing meeting list to those session-scoped pages.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependency import require_org_member
from app.db.base import get_db
from app.db.models import BotSession, CaptureSession, CoverageInterval, CoverageStatus, Meeting, Org

router = APIRouter(prefix="/api/v1/orgs/{org_id}/meetings", tags=["meetings"])


class MeetingListItem(BaseModel):
    id: str
    title: str
    platform: str
    scheduled_start: str | None = None
    scheduled_end: str | None = None
    latest_capture_session_id: str | None = None
    latest_capture_mode: str | None = None
    latest_capture_state: str | None = None
    latest_capture_error: str | None = None
    latest_bot_session_id: str | None = None
    latest_bot_status: str | None = None
    latest_bot_error: str | None = None
    has_coverage_gap: bool = False


@router.get("", response_model=list[MeetingListItem])
async def list_meetings(
    org_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> list[MeetingListItem]:
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "org not found")

    meetings = (
        db.execute(select(Meeting).where(Meeting.org_id == org_id).order_by(Meeting.created_at.desc()))
        .scalars()
        .all()
    )

    out: list[MeetingListItem] = []
    for meeting in meetings:
        latest_session = (
            db.execute(
                select(CaptureSession)
                .where(CaptureSession.meeting_id == meeting.id)
                .order_by(CaptureSession.created_at.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )
        latest_bot = (
            db.execute(
                select(BotSession)
                .where(BotSession.meeting_id == meeting.id)
                .order_by(BotSession.created_at.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )

        has_gap = False
        if latest_session is not None:
            has_gap = (
                db.execute(
                    select(CoverageInterval.id)
                    .where(
                        CoverageInterval.capture_session_id == latest_session.id,
                        CoverageInterval.status != CoverageStatus.OK,
                    )
                    .limit(1)
                ).scalar_one_or_none()
                is not None
            )

        out.append(
            MeetingListItem(
                id=meeting.id,
                title=meeting.title or "Untitled meeting",
                platform=meeting.platform,
                scheduled_start=meeting.scheduled_start.isoformat() if meeting.scheduled_start else None,
                scheduled_end=meeting.scheduled_end.isoformat() if meeting.scheduled_end else None,
                latest_capture_session_id=latest_session.id if latest_session else None,
                latest_capture_mode=latest_session.mode if latest_session else None,
                latest_capture_state=latest_session.state.value if latest_session else None,
                latest_capture_error=latest_session.error if latest_session else None,
                latest_bot_session_id=latest_bot.id if latest_bot else None,
                latest_bot_status=latest_bot.status.value if latest_bot else None,
                latest_bot_error=latest_bot.error if latest_bot else None,
                has_coverage_gap=has_gap,
            )
        )

    return out
