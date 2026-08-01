"""Durable Postgres job queue — FOR UPDATE SKIP LOCKED, no external broker.

Claim semantics: a worker atomically claims one runnable job; concurrent
workers skip locked rows, so horizontal scaling is adding replicas.
Retry: failed jobs are re-queued with exponential backoff until max_attempts.
"""

import socket
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import CaptureSession, JobStatus, PipelineJob
from app.orchestrator.pipeline import FIRST_STAGE, next_stage, running_state

WORKER_ID = f"{socket.gethostname()}:{id(object())}"


def enqueue_pipeline(db: Session, org_id: str, capture_session_id: str) -> PipelineJob:
    """Start the pipeline for a capture session at its first stage."""
    return enqueue_stage(db, org_id, capture_session_id, FIRST_STAGE)


def enqueue_stage(db: Session, org_id: str, capture_session_id: str, stage: str) -> PipelineJob:
    job = PipelineJob(org_id=org_id, capture_session_id=capture_session_id, stage=stage)
    db.add(job)
    db.flush()
    return job


def claim_next_job(db: Session) -> PipelineJob | None:
    """Atomically claim one runnable job (or None). Caller owns the transaction."""
    now = datetime.now(UTC)
    job = db.execute(
        select(PipelineJob)
        .where(PipelineJob.status == JobStatus.QUEUED, PipelineJob.run_at <= now)
        .order_by(PipelineJob.run_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if job is None:
        return None
    job.status = JobStatus.RUNNING
    job.locked_by = WORKER_ID
    job.locked_at = now
    job.attempts += 1
    # reflect stage on the capture session (FSM state)
    session = db.get(CaptureSession, job.capture_session_id)
    if session is not None:
        session.state = running_state(job.stage)
    db.flush()
    return job


def complete_job(db: Session, job: PipelineJob) -> None:
    """Mark done and enqueue the next stage (deterministic transition)."""
    job.status = JobStatus.DONE
    nxt = next_stage(job.stage)
    if nxt is not None:
        enqueue_stage(db, job.org_id, job.capture_session_id, nxt)
    else:
        session = db.get(CaptureSession, job.capture_session_id)
        if session is not None:
            from app.db.models import CaptureState

            session.state = CaptureState.DONE
    db.flush()


def fail_job(db: Session, job: PipelineJob, error: str) -> None:
    """Retry with exponential backoff; mark FAILED (and the session) when exhausted."""
    if job.attempts >= job.max_attempts:
        job.status = JobStatus.FAILED
        job.error = error
        session = db.get(CaptureSession, job.capture_session_id)
        if session is not None:
            from app.db.models import CaptureState

            session.state = CaptureState.FAILED
            session.error = f"stage={job.stage}: {error}"
    else:
        job.status = JobStatus.QUEUED
        job.error = error
        backoff = timedelta(seconds=min(300, 5 * 2**job.attempts))
        job.run_at = datetime.now(UTC) + backoff
        job.locked_by = None
        job.locked_at = None
    db.flush()


def reap_stuck_jobs(db: Session, stale_after_minutes: int = 30) -> int:
    """Re-queue RUNNING jobs whose worker died (locked_at too old)."""
    cutoff = datetime.now(UTC) - timedelta(minutes=stale_after_minutes)
    stuck = (
        db.execute(
            select(PipelineJob)
            .where(PipelineJob.status == JobStatus.RUNNING, PipelineJob.locked_at < cutoff)
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .all()
    )
    for job in stuck:
        job.status = JobStatus.QUEUED
        job.locked_by = None
        job.locked_at = None
        job.run_at = datetime.now(UTC)
    db.flush()
    return len(stuck)
