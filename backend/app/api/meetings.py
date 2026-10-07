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
from app.db.models import (
    BotSession,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureSession,
    CaptureState,
    CoverageInterval,
    CoverageStatus,
    Meeting,
    Org,
)

router = APIRouter(prefix="/api/v1/orgs/{org_id}/meetings", tags=["meetings"])

# Ordered pipeline stages used for progress computation.
_PIPELINE_STAGES = [
    "acquire",
    "diarize",
    "identify",
    "transcribe",
    "screen",
    "understand",
    "verify",
    "remember",
    "propose",
    "report",
]
_TOTAL_STAGES = len(_PIPELINE_STAGES)

_STATE_TO_STAGE: dict[CaptureState, str] = {
    CaptureState.ACQUIRING: "acquire",
    CaptureState.ACQUIRED: "screen",  # provider-transcript sessions start here
    CaptureState.DIARIZING: "diarize",
    CaptureState.IDENTIFYING: "identify",
    CaptureState.TRANSCRIBING: "transcribe",
    CaptureState.PROCESSING_SCREEN: "screen",
    CaptureState.UNDERSTANDING: "understand",
    CaptureState.VERIFYING: "verify",
    CaptureState.REMEMBERING: "remember",
    CaptureState.PROPOSING: "propose",
    CaptureState.REPORTING: "report",
}


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
    # Durable capture request state (new path via CaptureRequest).
    latest_capture_request_id: str | None = None
    latest_capture_request_status: str | None = None
    has_coverage_gap: bool = False
    report_ready: bool = False


class SessionStatus(BaseModel):
    """Processing status for a single CaptureSession — used by the UI to gate report display."""

    capture_session_id: str
    state: str
    report_ready: bool
    report_title: str | None = None
    report_summary: str | None = None
    has_coverage_gap: bool = False
    # 0–100 progress estimate based on which pipeline stage is running.
    pipeline_progress_pct: int = 0
    error: str | None = None


def _pipeline_progress(state: CaptureState) -> int:
    """Return 0-100 completion percentage for a CaptureSession state."""
    if state == CaptureState.DONE:
        return 100
    if state == CaptureState.FAILED:
        return 0
    current = _STATE_TO_STAGE.get(state)
    if current is None:
        return 0
    try:
        idx = _PIPELINE_STAGES.index(current)
    except ValueError:
        return 0
    return int((idx / _TOTAL_STAGES) * 100)


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
        latest_request = (
            db.execute(
                select(CaptureRequest)
                .where(CaptureRequest.meeting_id == meeting.id)
                .order_by(CaptureRequest.created_at.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )

        has_gap = False
        report_ready = False
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
            report_ready = latest_session.state == CaptureState.DONE

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
                latest_capture_request_id=latest_request.id if latest_request else None,
                latest_capture_request_status=latest_request.status.value if latest_request else None,
                has_coverage_gap=has_gap,
                report_ready=report_ready,
            )
        )

    return out


@router.get("/{meeting_id}/capture-status", response_model=SessionStatus)
async def get_capture_status(
    org_id: str,
    meeting_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> SessionStatus:
    """Return the processing status of the most recent CaptureSession for a meeting.

    Used by the UI to decide whether to show the report, a loading state, or an error.
    Returns 404 when no capture session exists yet (meeting never captured or not yet
    ingested from the provider transcript lane).
    """
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "org not found")
    meeting = db.get(Meeting, meeting_id)
    if meeting is None or meeting.org_id != org_id:
        raise HTTPException(404, "meeting not found")

    session = (
        db.execute(
            select(CaptureSession)
            .where(CaptureSession.meeting_id == meeting_id)
            .order_by(CaptureSession.created_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if session is None:
        raise HTTPException(404, "no capture session for this meeting")

    has_gap = (
        db.execute(
            select(CoverageInterval.id)
            .where(
                CoverageInterval.capture_session_id == session.id,
                CoverageInterval.status != CoverageStatus.OK,
            )
            .limit(1)
        ).scalar_one_or_none()
        is not None
    )

    return SessionStatus(
        capture_session_id=session.id,
        state=session.state.value,
        report_ready=session.state == CaptureState.DONE,
        report_title=session.report_title,
        report_summary=session.report_summary,
        has_coverage_gap=has_gap,
        pipeline_progress_pct=_pipeline_progress(session.state),
        error=session.error,
    )
