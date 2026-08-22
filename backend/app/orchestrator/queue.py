"""Durable Postgres job queue — FOR UPDATE SKIP LOCKED, no external broker.

Claim semantics: a worker atomically claims one runnable job; concurrent
workers skip locked rows, so horizontal scaling is adding replicas.
Retry: failed jobs are re-queued with exponential backoff until max_attempts.

**The claim must be committed before the stage handler runs.** `attempts` is
incremented by `claim_next_job`; if that increment is still uncommitted when
the handler raises, the caller's rollback reverts it and `fail_job` then reads
`attempts == 0` from a fresh session — so `attempts >= max_attempts` is never
true, `FAILED` is unreachable, and the backoff is pinned at its first step
forever. `app.orchestrator.worker.run_once` therefore claims and commits in
its own transaction before dispatching; do not collapse those back together.
"""

import os
import socket
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import CaptureSession, JobStatus, PipelineJob
from app.orchestrator.pipeline import FIRST_STAGE, next_stage, running_state

# pid + random suffix — uniquely identifies this process on this host.
# id(object()) reuses memory addresses and is not unique across processes.
# Kept inside PipelineJob.locked_by's String(64): a long hostname plus a
# full uuid4 overflows it (Postgres rejects; SQLite would accept silently).
WORKER_ID = f"{socket.gethostname()[:24]}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


def enqueue_pipeline(
    db: Session, org_id: str, capture_session_id: str, *, run_at: datetime | None = None
) -> PipelineJob:
    """Start the pipeline for a capture session at its first stage.

    `run_at` lets a caller schedule the first claim in the future rather than
    immediately — the scheduler (app/orchestrator/scheduler.py) uses this so
    a Mode A2 session's `acquire` job doesn't fire until after the meeting
    has actually ended and the platform has had time to process the
    recording; Mode D's upload endpoint always wants `None` (now), since the
    audio is already sitting in blob storage the moment it's called.
    """
    return enqueue_stage(db, org_id, capture_session_id, FIRST_STAGE, run_at=run_at)


def enqueue_stage(
    db: Session, org_id: str, capture_session_id: str, stage: str, *, run_at: datetime | None = None
) -> PipelineJob:
    job = PipelineJob(org_id=org_id, capture_session_id=capture_session_id, stage=stage)
    if run_at is not None:
        job.run_at = run_at
    db.add(job)
    db.flush()
    return job


def claim_next_job(db: Session) -> PipelineJob | None:
    """Atomically claim one runnable job (or None).

    Caller owns the transaction and must commit it before running the handler
    -- see this module's docstring for why.

    Fairness: orgs already at worker_max_inflight_per_org RUNNING jobs are
    skipped so one org bulk-uploading recordings can't starve every other
    tenant. Jobs are skipped, never reordered -- per-org FIFO is preserved.
    """
    now = datetime.now(UTC)
    cap = get_settings().worker_max_inflight_per_org
    saturated_orgs = (
        select(PipelineJob.org_id)
        .where(PipelineJob.status == JobStatus.RUNNING)
        .group_by(PipelineJob.org_id)
        .having(func.count() >= cap)
    )
    job = db.execute(
        select(PipelineJob)
        .where(
            PipelineJob.status == JobStatus.QUEUED,
            PipelineJob.run_at <= now,
            PipelineJob.org_id.not_in(saturated_orgs),
        )
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


def requeue_job(db: Session, job: PipelineJob) -> None:
    """Return a FAILED job to the queue (ops action -- caller believes the cause is fixed)."""
    job.status = JobStatus.QUEUED
    job.attempts = 0
    job.error = None
    job.locked_by = None
    job.locked_at = None
    job.run_at = datetime.now(UTC)
    session = db.get(CaptureSession, job.capture_session_id)
    if session is not None:
        session.state = running_state(job.stage)
        session.error = None
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
