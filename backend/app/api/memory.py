"""Project and customer memory endpoints (F09)."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session
from typing import Any

from app.auth.dependency import get_current_user, require_org_member
from app.db.base import get_db
from app.db.models import Customer, Org, Project, ProjectMember, SummaryState, SummaryVersion, User
from app.memory.project_memory import latest_summary, rebuild_customer_memory, rebuild_project_memory

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["memory"])


class MemoryView(BaseModel):
    id: str
    scope_kind: str
    scope_id: str
    state: str
    input_revision_hash: str
    structured_summary: dict[str, Any]
    source_meeting_ids: list[str]
    error: str | None = None


def _require_org(db: Session, org_id: str) -> None:
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "workspace not found")


def _require_project_member(db: Session, org_id: str, project_id: str, user_id: str) -> None:
    member = db.execute(
        select(ProjectMember).where(
            ProjectMember.org_id == org_id,
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user_id,
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(404, "project not found")


@router.get("/projects/{project_id}/memory", response_model=MemoryView)
def get_project_memory(
    org_id: str,
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> MemoryView:
    """Return the current project memory summary.

    Computes or retrieves the latest READY SummaryVersion for the project.
    Only project members can access.
    """
    _require_org(db, org_id)
    project = db.get(Project, project_id)
    if project is None or project.org_id != org_id:
        raise HTTPException(404, "project not found")
    _require_project_member(db, org_id, project_id, user.id)

    sv = latest_summary(db, "project", project_id)
    if sv is None:
        # Build it synchronously — first call after meeting assignment.
        sv = rebuild_project_memory(lambda: db, org_id, project_id)

    return MemoryView(
        id=sv.id,
        scope_kind=sv.scope_kind,
        scope_id=sv.scope_id,
        state=sv.state,
        input_revision_hash=sv.input_revision_hash,
        structured_summary=sv.structured_summary,
        source_meeting_ids=sv.source_meeting_ids,
        error=sv.error,
    )


@router.get("/customers/{customer_id}/memory", response_model=MemoryView)
def get_customer_memory(
    org_id: str,
    customer_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> MemoryView:
    """Return the customer memory aggregated from the caller's visible projects.

    The caller only gets summaries from meetings in projects they can access.
    """
    _require_org(db, org_id)
    customer = db.get(Customer, customer_id)
    if customer is None or customer.org_id != org_id:
        raise HTTPException(404, "customer not found")

    sv = latest_summary(db, "customer", customer_id)
    if sv is None:
        sv = rebuild_customer_memory(lambda: db, org_id, customer_id)

    return MemoryView(
        id=sv.id,
        scope_kind=sv.scope_kind,
        scope_id=sv.scope_id,
        state=sv.state,
        input_revision_hash=sv.input_revision_hash,
        structured_summary=sv.structured_summary,
        source_meeting_ids=sv.source_meeting_ids,
        error=sv.error,
    )
