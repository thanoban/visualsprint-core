"""Unit coverage for app.orchestrator.queue -- the Postgres-backed FSM job
queue (CLAUDE.md rule 1: deterministic software owns stage transitions, not
agents). Uses an isolated in-memory SQLite DB, same pattern as
tests/orchestrator/test_scheduler.py -- exercises claim/complete/fail/reap
ordering and state-transition logic on a single connection. SQLite has no
real `FOR UPDATE SKIP LOCKED` semantics, so true concurrent-worker locking
is not proven here; that's implicitly covered by the shared dev Postgres in
tests/test_upload_pipeline.py.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import CaptureSession, CaptureState, JobStatus, Meeting, Org, PipelineJob
from app.orchestrator.queue import (
    claim_next_job,
    complete_job,
    enqueue_pipeline,
    enqueue_stage,
    fail_job,
    reap_stuck_jobs,
)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _seed_session(db) -> CaptureSession:
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    meeting = Meeting(org_id=org.id, title="Standup")
    db.add(meeting)
    db.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.commit()
    return session


def test_enqueue_pipeline_starts_at_the_first_stage(db):
    session = _seed_session(db)

    job = enqueue_pipeline(db, session.org_id, session.id)

    assert job.stage == "acquire"
    assert job.status == JobStatus.QUEUED
    assert job.attempts == 0


def test_enqueue_pipeline_with_a_future_run_at_is_not_yet_claimable(db):
    session = _seed_session(db)
    future = datetime.now(UTC) + timedelta(hours=1)

    enqueue_pipeline(db, session.org_id, session.id, run_at=future)

    assert claim_next_job(db) is None


def test_claim_next_job_claims_the_earliest_runnable_job_and_syncs_session_state(db):
    session = _seed_session(db)
    job = enqueue_pipeline(db, session.org_id, session.id)

    claimed = claim_next_job(db)

    assert claimed is not None
    assert claimed.id == job.id
    assert claimed.status == JobStatus.RUNNING
    assert claimed.locked_by
    assert claimed.locked_at is not None
    assert claimed.attempts == 1
    db.refresh(session)
    assert session.state == CaptureState.ACQUIRING


def test_claim_next_job_returns_none_when_nothing_is_runnable(db):
    assert claim_next_job(db) is None


def test_complete_job_advances_to_the_next_stage(db):
    session = _seed_session(db)
    job = enqueue_pipeline(db, session.org_id, session.id)
    claim_next_job(db)

    complete_job(db, job)

    assert job.status == JobStatus.DONE
    next_job = db.query(PipelineJob).filter(PipelineJob.stage == "transcribe").one()
    assert next_job.status == JobStatus.QUEUED


def test_complete_job_on_the_final_stage_marks_the_session_done(db):
    session = _seed_session(db)
    job = enqueue_stage(db, session.org_id, session.id, "report")
    claim_next_job(db)

    complete_job(db, job)

    assert job.status == JobStatus.DONE
    assert db.query(PipelineJob).filter(PipelineJob.capture_session_id == session.id).count() == 1
    db.refresh(session)
    assert session.state == CaptureState.DONE


def test_fail_job_requeues_with_backoff_before_exhausting_attempts(db):
    session = _seed_session(db)
    job = enqueue_pipeline(db, session.org_id, session.id, run_at=datetime.now(UTC))
    job.max_attempts = 3
    db.commit()
    claim_next_job(db)  # attempts -> 1

    fail_job(db, job, "vendor timeout")

    assert job.status == JobStatus.QUEUED
    assert job.error == "vendor timeout"
    assert job.locked_by is None
    assert job.locked_at is None
    assert job.run_at > datetime.now(UTC)
    db.refresh(session)
    assert session.state != CaptureState.FAILED


def test_fail_job_marks_failed_once_max_attempts_is_reached(db):
    session = _seed_session(db)
    job = enqueue_pipeline(db, session.org_id, session.id)
    job.max_attempts = 1
    db.commit()
    claim_next_job(db)  # attempts -> 1, equals max_attempts

    fail_job(db, job, "vendor unreachable")

    assert job.status == JobStatus.FAILED
    assert job.error == "vendor unreachable"
    db.refresh(session)
    assert session.state == CaptureState.FAILED
    assert "acquire" in session.error
    assert "vendor unreachable" in session.error


def test_reap_stuck_jobs_requeues_running_jobs_with_a_stale_lock(db):
    session = _seed_session(db)
    job = enqueue_pipeline(db, session.org_id, session.id)
    claim_next_job(db)
    job.locked_at = datetime.now(UTC) - timedelta(minutes=45)
    db.commit()

    reaped = reap_stuck_jobs(db, stale_after_minutes=30)

    assert reaped == 1
    db.refresh(job)
    assert job.status == JobStatus.QUEUED
    assert job.locked_by is None
    assert job.locked_at is None


def test_reap_stuck_jobs_leaves_recently_locked_jobs_alone(db):
    session = _seed_session(db)
    job = enqueue_pipeline(db, session.org_id, session.id)
    claim_next_job(db)

    reaped = reap_stuck_jobs(db, stale_after_minutes=30)

    assert reaped == 0
    db.refresh(job)
    assert job.status == JobStatus.RUNNING
