"""HTTP projections for the founder's project-organized meeting history."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user, require_org_member
from app.db.base import get_db
from app.db.models import Customer, ProjectMember, User
from app.modules.projects.meeting_views import MeetingPage, MeetingView, meeting_page

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["meeting-history-v2"])


@router.get("/meetings", response_model=MeetingPage)
def list_meetings(
    org_id: str,
    project_id: str | None = None,
    customer_id: str | None = None,
    unassigned: bool = False,
    cursor: str | None = Query(default=None, max_length=512),
    limit: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> MeetingPage:
    if sum((bool(project_id), bool(customer_id), unassigned)) > 1:
        raise HTTPException(422, "choose one meeting scope")
    if (
        project_id
        and db.scalar(
            select(ProjectMember.id).where(
                ProjectMember.org_id == org_id,
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user.id,
            )
        )
        is None
    ):
        raise HTTPException(404, "project not found")
    if (
        customer_id
        and db.scalar(
            select(Customer.id).where(
                Customer.org_id == org_id,
                Customer.id == customer_id,
            )
        )
        is None
    ):
        raise HTTPException(404, "customer not found")
    try:
        return meeting_page(
            db,
            org_id,
            user.id,
            project_id=project_id,
            customer_id=customer_id,
            unassigned=unassigned,
            cursor=cursor,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(422, "invalid meeting cursor") from exc


@router.get("/meetings/{meeting_id}", response_model=MeetingView)
def get_meeting(
    org_id: str,
    meeting_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> MeetingView:
    page = meeting_page(db, org_id, user.id, meeting_id=meeting_id, limit=1)
    if not page.items:
        raise HTTPException(404, "meeting not found")
    return page.items[0]
