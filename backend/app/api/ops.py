"""Failure visibility and manual requeue — the pipeline's dead-letter surface.

`JobStatus.FAILED` was written in exactly one place (app/orchestrator/queue.py)
and read nowhere: no endpoint listed failed work, nothing alerted, and there
was no way back. A customer's meeting could fail permanently with the only
trace being a structlog line, while the UI showed it as still processing.

These routes make an exhausted job visible to the org it belongs to and give
an operator a way to put it back once the cause is fixed (credentials
restored, quota granted, ffmpeg provisioned). Requeueing resets `attempts` —
see `queue.requeue_job` for why.

Also exposes the LLM spend ledger (`llm_call`, app/orchestrator/
llm_accounting.py), because "why did this cost so much" and "why did this
fail" are usually the same investigation.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import InstrumentedAttribute, Session

from app.auth.dependency import require_org_member
from app.db.base import get_db
from app.db.models import CaptureSession, JobStatus, LlmCall, Meeting, Org, PipelineJob
from app.orchestrator.audit import log_audit_event
from app.orchestrator.llm_accounting import org_tokens_used_this_month
from app.orchestrator.queue import requeue_job

router = APIRouter(prefix="/api/v1/orgs/{org_id}", tags=["ops"])


class FailedJobOut(BaseModel):
    job_id: str
    capture_session_id: str
    meeting_title: str | None = None
    stage: str
    attempts: int
    max_attempts: int
    error: str | None = None
    failed_at: datetime | None = None
    session_state: str


class LlmSpendOut(BaseModel):
    month_to_date_tokens: int
    monthly_token_budget: int | None = None
    over_budget: bool
    by_stage: dict[str, int]
    by_model: dict[str, int]
    failed_calls: int


@router.get("/failed-jobs", response_model=list[FailedJobOut])
async def list_failed_jobs(
    org_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> list[FailedJobOut]:
    """Every job in this org that exhausted its retries."""
    jobs = (
        db.execute(
            select(PipelineJob)
            .where(PipelineJob.org_id == org_id, PipelineJob.status == JobStatus.FAILED)
            .order_by(PipelineJob.updated_at.desc())
        )
        .scalars()
        .all()
    )
    out: list[FailedJobOut] = []
    for job in jobs:
        session = db.get(CaptureSession, job.capture_session_id)
        meeting = db.get(Meeting, session.meeting_id) if session is not None else None
        out.append(
            FailedJobOut(
                job_id=job.id,
                capture_session_id=job.capture_session_id,
                meeting_title=meeting.title if meeting is not None else None,
                stage=job.stage,
                attempts=job.attempts,
                max_attempts=job.max_attempts,
                error=job.error,
                failed_at=job.updated_at,
                session_state=session.state.value if session is not None else "unknown",
            )
        )
    return out


@router.post("/failed-jobs/{job_id}/requeue", response_model=FailedJobOut)
async def requeue_failed_job(
    org_id: str,
    job_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> FailedJobOut:
    """Return one exhausted job to the queue.

    Scoped by org_id in the lookup, not just by job_id: a valid member of org
    A must not be able to requeue org B's job by guessing an id.
    """
    job = db.execute(
        select(PipelineJob).where(PipelineJob.id == job_id, PipelineJob.org_id == org_id)
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status != JobStatus.FAILED:
        raise HTTPException(409, f"job is {job.status.value}, only failed jobs can be requeued")

    requeue_job(db, job)
    log_audit_event(
        db,
        org_id=org_id,
        actor="ops",
        event="pipeline_job_requeued",
        detail={"job_id": job.id, "stage": job.stage},
    )
    db.commit()

    session = db.get(CaptureSession, job.capture_session_id)
    meeting = db.get(Meeting, session.meeting_id) if session is not None else None
    return FailedJobOut(
        job_id=job.id,
        capture_session_id=job.capture_session_id,
        meeting_title=meeting.title if meeting is not None else None,
        stage=job.stage,
        attempts=job.attempts,
        max_attempts=job.max_attempts,
        error=job.error,
        failed_at=job.updated_at,
        session_state=session.state.value if session is not None else "unknown",
    )


@router.get("/llm-spend", response_model=LlmSpendOut)
async def get_llm_spend(
    org_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> LlmSpendOut:
    """Month-to-date LLM token usage for this org, broken down by stage and model."""
    org = db.get(Org, org_id)
    month_start = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    def _grouped(column: InstrumentedAttribute[str]) -> dict[str, int]:
        rows = db.execute(
            select(column, func.sum(LlmCall.input_tokens + LlmCall.output_tokens))
            .where(LlmCall.org_id == org_id, LlmCall.at >= month_start)
            .group_by(column)
        ).all()
        return {str(key): int(total or 0) for key, total in rows}

    used = org_tokens_used_this_month(db, org_id)
    budget = org.monthly_llm_token_budget if org is not None else None
    failed = db.execute(
        select(func.count())
        .select_from(LlmCall)
        .where(LlmCall.org_id == org_id, LlmCall.at >= month_start, LlmCall.ok.is_(False))
    ).scalar_one()
    return LlmSpendOut(
        month_to_date_tokens=used,
        monthly_token_budget=budget,
        over_budget=budget is not None and used >= budget,
        by_stage=_grouped(LlmCall.stage),
        by_model=_grouped(LlmCall.model),
        failed_calls=int(failed or 0),
    )
