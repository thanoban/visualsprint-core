"""Authorized, bounded meeting history shared by project/customer screens."""

import base64
import binascii
import json
from datetime import UTC, datetime
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.db.models import (
    CaptureRequest,
    CaptureSession,
    CaptureState,
    Meeting,
    MeetingAssignment,
    Project,
    ProjectMember,
)
from app.modules.projects.access import visible_meeting_ids


class MeetingView(BaseModel):
    id: str
    title: str
    platform: str
    created_at: str
    scheduled_start: str | None
    project_id: str | None
    assignment_version: int
    can_move: bool
    capture_session_id: str | None
    processing_state: str | None
    capture_request_id: str | None
    capture_status: str | None
    report_ready: bool


class MeetingPage(BaseModel):
    items: list[MeetingView]
    next_cursor: str | None


def _cursor(value: str) -> tuple[datetime, str]:
    try:
        document = json.loads(base64.urlsafe_b64decode(value.encode()))
        timestamp = datetime.fromisoformat(document[0])
        identifier = str(UUID(document[1]))
        if timestamp.tzinfo is None:
            raise ValueError("missing timezone")
        return timestamp, identifier
    except (ValueError, TypeError, KeyError, IndexError, binascii.Error) as exc:
        raise ValueError("invalid meeting cursor") from exc


def meeting_page(
    db: Session,
    org_id: str,
    user_id: str,
    *,
    project_id: str | None = None,
    customer_id: str | None = None,
    unassigned: bool = False,
    meeting_id: str | None = None,
    cursor: str | None = None,
    limit: int = 25,
) -> MeetingPage:
    if not 1 <= limit <= 100:
        raise ValueError("meeting page limit must be between 1 and 100")
    latest_session = (
        select(CaptureSession.id)
        .where(CaptureSession.org_id == org_id, CaptureSession.meeting_id == Meeting.id)
        .order_by(CaptureSession.created_at.desc(), CaptureSession.id.desc())
        .limit(1)
        .correlate(Meeting)
        .scalar_subquery()
    )
    latest_request = (
        select(CaptureRequest.id)
        .where(CaptureRequest.org_id == org_id, CaptureRequest.meeting_id == Meeting.id)
        .order_by(CaptureRequest.created_at.desc(), CaptureRequest.id.desc())
        .limit(1)
        .correlate(Meeting)
        .scalar_subquery()
    )
    query = (
        select(Meeting, MeetingAssignment, CaptureSession, CaptureRequest, ProjectMember.role)
        .select_from(Meeting)
        .outerjoin(
            MeetingAssignment,
            and_(MeetingAssignment.org_id == org_id, MeetingAssignment.meeting_id == Meeting.id),
        )
        .outerjoin(
            ProjectMember,
            and_(
                ProjectMember.org_id == org_id,
                ProjectMember.project_id == MeetingAssignment.project_id,
                ProjectMember.user_id == user_id,
            ),
        )
        .outerjoin(CaptureSession, CaptureSession.id == latest_session)
        .outerjoin(CaptureRequest, CaptureRequest.id == latest_request)
        .where(Meeting.id.in_(visible_meeting_ids(org_id, user_id)))
    )
    if project_id:
        query = query.where(MeetingAssignment.project_id == project_id)
    if customer_id:
        query = query.where(
            MeetingAssignment.project_id.in_(
                select(Project.id).where(
                    Project.org_id == org_id, Project.customer_id == customer_id
                )
            )
        )
    if unassigned:
        query = query.where(MeetingAssignment.id.is_(None), Meeting.owner_user_id == user_id)
    if meeting_id:
        query = query.where(Meeting.id == meeting_id)
    if cursor:
        timestamp, identifier = _cursor(cursor)
        query = query.where(
            or_(
                Meeting.created_at < timestamp,
                and_(Meeting.created_at == timestamp, Meeting.id < identifier),
            )
        )
    rows = db.execute(
        query.order_by(Meeting.created_at.desc(), Meeting.id.desc()).limit(limit + 1)
    ).all()
    items = [
        MeetingView(
            id=meeting.id,
            title=meeting.title or "Untitled meeting",
            platform=meeting.platform,
            created_at=meeting.created_at.isoformat(),
            scheduled_start=meeting.scheduled_start.isoformat()
            if meeting.scheduled_start
            else None,
            project_id=assignment.project_id if assignment else None,
            assignment_version=assignment.version if assignment else 0,
            can_move=meeting.owner_user_id == user_id
            and (assignment is None or role in {"owner", "editor"}),
            capture_session_id=session.id if session else None,
            processing_state=session.state.value if session else None,
            capture_request_id=request.id if request else None,
            capture_status=request.status.value if request else None,
            report_ready=session is not None and session.state == CaptureState.DONE,
        )
        for meeting, assignment, session, request, role in rows[:limit]
    ]
    next_cursor = None
    if len(rows) > limit:
        meeting = rows[limit - 1][0]
        timestamp = meeting.created_at
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=UTC)
        next_cursor = base64.urlsafe_b64encode(
            json.dumps([timestamp.isoformat(), meeting.id]).encode()
        ).decode()
    return MeetingPage(items=items, next_cursor=next_cursor)
