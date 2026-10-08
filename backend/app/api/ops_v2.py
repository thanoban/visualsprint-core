"""F13 workspace operations — export and deletion jobs.

POST /exports  — enqueue an async export of a project or workspace
GET /exports/{id} — poll export job status
POST /deletions — enqueue an async deletion of a project or workspace
GET /deletions/{id} — poll deletion job status

Both jobs are persisted atomically with an outbox event. Separately supervised
workers generate authenticated text exports or verify external cleanup before
primary-store erasure. Deletion tombstones hide content at acceptance; failures
remain visible in creator-private, retryable receipts.

Architecture rules applied:
- Export downloads require current access and unchanged source revisions.
- Workspace deletion requires org-owner role (403 for members).
- Project deletion requires project-owner role.
"""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import JSONResponse
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
    OutboxEvent,
    OutboxStatus,
    ProjectMember,
    User,
)
from app.modules.data_rights.deletions import CleanupPending, accept_deletion
from app.modules.data_rights.exports import ExportUnavailable, build_manifest, utc

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
    key: str | None = Header(default=None, alias="Idempotency-Key", max_length=255),
) -> ExportJobView:
    """Enqueue an async export.  Returns 202 with a job ID to poll.

    workspace scope requires org owner; project scope requires project member.
    """
    _require_org(db, org_id)
    if body.scope_kind == "workspace":
        if body.scope_id != org_id:
            raise HTTPException(404, "workspace not found")
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

    db.scalar(select(Org.id).where(Org.id == org_id).with_for_update())
    revision = hashlib.sha256(f"{user.id}:{key or uuid.uuid4()}".encode()).hexdigest()
    event = db.scalar(
        select(OutboxEvent).where(
            OutboxEvent.org_id == org_id,
            OutboxEvent.operation == "data.export",
            OutboxEvent.input_revision == revision,
        )
    )
    if event:
        existing = db.get(ExportJob, event.entity_id)
        if existing is None or existing.created_by != user.id:
            raise HTTPException(404, "export job not found")
        if existing.scope_kind != body.scope_kind or existing.scope_id != body.scope_id:
            raise HTTPException(409, "idempotency key was used for another export scope")
        return _export_view(existing)
    job = ExportJob(
        org_id=org_id,
        scope_kind=body.scope_kind,
        scope_id=body.scope_id,
        created_by=user.id,
        status=AsyncJobStatus.PENDING,
    )
    db.add(job)
    db.flush()
    db.add(
        OutboxEvent(
            org_id=org_id,
            operation="data.export",
            entity_id=job.id,
            input_revision=revision,
            payload={},
            max_attempts=3,
        )
    )
    db.commit()
    return _export_view(job)


@router.get("/exports/{job_id}/download")
def download_export(
    org_id: str,
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> JSONResponse:
    job = db.scalar(
        select(ExportJob)
        .where(ExportJob.org_id == org_id, ExportJob.id == job_id, ExportJob.created_by == user.id)
        .execution_options(populate_existing=True)
    )
    if job is None:
        raise HTTPException(404, "export not found")
    if job.status != AsyncJobStatus.DONE or job.manifest is None or job.completed_at is None:
        raise HTTPException(409, "export not ready")
    if utc(job.completed_at) < datetime.now(UTC) - timedelta(hours=24):
        raise HTTPException(410, "export expired; request a new export")
    try:
        _manifest, digest = build_manifest(db, job)
    except ExportUnavailable as exc:
        raise HTTPException(404, "export source access changed") from exc
    if digest != job.source_hash:
        raise HTTPException(409, "export sources changed; request a new export")
    return JSONResponse(
        job.manifest,
        headers={
            "Content-Disposition": f'attachment; filename="visualsprint-{job.id}.json"',
            "Cache-Control": "no-store",
        },
    )


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
        select(ExportJob)
        .where(ExportJob.id == job_id, ExportJob.org_id == org_id)
        .execution_options(populate_existing=True)
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
    key: str | None = Header(default=None, alias="Idempotency-Key", max_length=255),
) -> DeletionJobView:
    """Enqueue an irreversible async deletion.  Returns 202 with a job ID.

    workspace scope requires org owner; project scope requires project owner.
    """
    db.scalar(select(Org.id).where(Org.id == org_id).with_for_update())
    revision = hashlib.sha256(f"{user.id}:{key or uuid.uuid4()}".encode()).hexdigest()
    event = db.scalar(
        select(OutboxEvent).where(
            OutboxEvent.org_id == org_id,
            OutboxEvent.operation == "data.delete",
            OutboxEvent.input_revision == revision,
        )
    )
    if event:
        existing = db.get(DeletionJob, event.entity_id)
        if existing is None or existing.created_by != user.id:
            raise HTTPException(404, "deletion job not found")
        if existing.scope_kind != body.scope_kind or existing.scope_id != body.scope_id:
            raise HTTPException(409, "idempotency key was used for another deletion scope")
        return _deletion_view(existing)
    org = _require_org(db, org_id)
    if org.deleted_at is not None:
        raise HTTPException(404, "workspace not found")
    require_org_member(org_id, user, db)
    if body.scope_kind == "workspace":
        if body.scope_id != org_id:
            raise HTTPException(404, "workspace not found")
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
    db.flush()
    try:
        accept_deletion(db, job)
    except CleanupPending as exc:
        db.rollback()
        raise HTTPException(409, str(exc)) from exc
    db.add(
        OutboxEvent(
            org_id=org_id,
            operation="data.delete",
            entity_id=job.id,
            input_revision=revision,
            payload={},
            max_attempts=8,
        )
    )
    db.commit()
    return _deletion_view(job)


@router.post("/deletions/{job_id}/retry", response_model=DeletionJobView, status_code=202)
def retry_deletion(
    org_id: str, job_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> DeletionJobView:
    job = db.scalar(
        select(DeletionJob)
        .where(
            DeletionJob.org_id == org_id,
            DeletionJob.id == job_id,
            DeletionJob.created_by == user.id,
        )
        .with_for_update()
    )
    if job is None:
        raise HTTPException(404, "deletion not found")
    if job.status == AsyncJobStatus.FAILED:
        event = db.scalar(
            select(OutboxEvent)
            .where(
                OutboxEvent.org_id == org_id,
                OutboxEvent.operation == "data.delete",
                OutboxEvent.entity_id == job.id,
            )
            .with_for_update()
        )
        if event is None:
            raise HTTPException(409, "legacy deletion needs operator recovery")
        event.status, event.attempts, event.error_code = OutboxStatus.PENDING, 0, None
        event.run_at = datetime.now(UTC)
        event.locked_at, event.locked_by = None, None
        event.fencing_version += 1
        job.status, job.error = AsyncJobStatus.PENDING, None
        db.commit()
    return _deletion_view(job)


@router.get("/deletions/{job_id}", response_model=DeletionJobView)
def get_deletion(
    org_id: str,
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DeletionJobView:
    job = db.execute(
        select(DeletionJob)
        .where(DeletionJob.id == job_id, DeletionJob.org_id == org_id)
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(404, "deletion job not found")
    if job.created_by != user.id:
        raise HTTPException(404, "deletion job not found")
    return _deletion_view(job)
