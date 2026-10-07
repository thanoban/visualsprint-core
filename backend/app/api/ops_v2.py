"""F13 workspace operations — export and deletion jobs.

POST /exports  — enqueue an async export of a project or workspace
GET /exports/{id} — poll export job status
POST /deletions — enqueue an async deletion of a project or workspace
GET /deletions/{id} — poll deletion job status

Both jobs are PENDING on creation.  A background worker (out of scope for this
slice) transitions them to RUNNING → DONE/FAILED.  The API surface is the
contract; the execution stub keeps the interface testable without a worker.

Architecture rules applied:
- No meeting content is returned by this API; IDs and status only.
- Workspace deletion requires org-owner role (403 for members).
- Project deletion requires project-owner role.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user, require_org_member
from app.db.base import get_db
from app.db.models import (
    AsyncJobStatus,
    DeletionJob,
    ExportJob,
    Org,
    OrgMember,
    Project,
    ProjectMember,
    User,
)

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["ops-v2"])


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _require_org(db: Session, org_id: str) -> Org:
    org = db.get(Org, org_id)
    if org is None:
        raise HTTPException(404, "workspace not found")
    return org


def _require_org_owner(db: Session, org_id: str, user_id: str) -> None:
    member = db.execute(
        select(OrgMember).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == user_id,
        )
    ).scalar_one_or_none()
    if member is None or member.role != "owner":
        raise HTTPException(403, "workspace owner required")


def _require_project_owner(db: Session, org_id: str, project_id: str, user_id: str) -> None:
    member = db.execute(
        select(ProjectMember).where(
            ProjectMember.org_id == org_id,
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user_id,
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(404, "project not found")
    if member.role != "owner":
        raise HTTPException(403, "project owner required")


# ---------------------------------------------------------------------------
# Export jobs
# ---------------------------------------------------------------------------


class ExportIn(BaseModel):
    scope_kind: str  # "project" | "workspace"
    scope_id: str


class ExportJobView(BaseModel):
    id: str
    scope_kind: str
    scope_id: str
    status: str
    download_url: str | None = None
    error: str | None = None


def _export_view(job: ExportJob) -> ExportJobView:
    return ExportJobView(
        id=job.id,
        scope_kind=job.scope_kind,
        scope_id=job.scope_id,
        status=job.status.value,
        download_url=job.download_url,
        error=job.error,
    )


@router.post("/exports", response_model=ExportJobView, status_code=202)
def create_export(
    org_id: str,
    body: ExportIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> ExportJobView:
    """Enqueue an async export.  Returns 202 with a job ID to poll.

    workspace scope requires org owner; project scope requires project member.
    """
    _require_org(db, org_id)
    if body.scope_kind == "workspace":
        _require_org_owner(db, org_id, user.id)
    elif body.scope_kind == "project":
        pm = db.execute(
            select(ProjectMember).where(
                ProjectMember.org_id == org_id,
                ProjectMember.project_id == body.scope_id,
                ProjectMember.user_id == user.id,
            )
        ).scalar_one_or_none()
        if pm is None:
            raise HTTPException(404, "project not found")
    else:
        raise HTTPException(422, "scope_kind must be 'project' or 'workspace'")

    job = ExportJob(
        org_id=org_id,
        scope_kind=body.scope_kind,
        scope_id=body.scope_id,
        created_by=user.id,
        status=AsyncJobStatus.PENDING,
    )
    db.add(job)
    db.commit()
    return _export_view(job)


@router.get("/exports/{job_id}", response_model=ExportJobView)
def get_export(
    org_id: str,
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> ExportJobView:
    _require_org(db, org_id)
    job = db.execute(
        select(ExportJob).where(ExportJob.id == job_id, ExportJob.org_id == org_id)
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(404, "export job not found")
    if job.created_by != user.id:
        raise HTTPException(404, "export job not found")
    return _export_view(job)


# ---------------------------------------------------------------------------
# Deletion jobs
# ---------------------------------------------------------------------------


class DeletionIn(BaseModel):
    scope_kind: str  # "project" | "workspace"
    scope_id: str


class DeletionJobView(BaseModel):
    id: str
    scope_kind: str
    scope_id: str
    status: str
    error: str | None = None


def _deletion_view(job: DeletionJob) -> DeletionJobView:
    return DeletionJobView(
        id=job.id,
        scope_kind=job.scope_kind,
        scope_id=job.scope_id,
        status=job.status.value,
        error=job.error,
    )


@router.post("/deletions", response_model=DeletionJobView, status_code=202)
def create_deletion(
    org_id: str,
    body: DeletionIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> DeletionJobView:
    """Enqueue an irreversible async deletion.  Returns 202 with a job ID.

    workspace scope requires org owner; project scope requires project owner.
    """
    _require_org(db, org_id)
    if body.scope_kind == "workspace":
        _require_org_owner(db, org_id, user.id)
    elif body.scope_kind == "project":
        _require_project_owner(db, org_id, body.scope_id, user.id)
    else:
        raise HTTPException(422, "scope_kind must be 'project' or 'workspace'")

    job = DeletionJob(
        org_id=org_id,
        scope_kind=body.scope_kind,
        scope_id=body.scope_id,
        created_by=user.id,
        status=AsyncJobStatus.PENDING,
    )
    db.add(job)
    db.commit()
    return _deletion_view(job)


@router.get("/deletions/{job_id}", response_model=DeletionJobView)
def get_deletion(
    org_id: str,
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> DeletionJobView:
    _require_org(db, org_id)
    job = db.execute(
        select(DeletionJob).where(DeletionJob.id == job_id, DeletionJob.org_id == org_id)
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(404, "deletion job not found")
    if job.created_by != user.id:
        raise HTTPException(404, "deletion job not found")
    return _deletion_view(job)
