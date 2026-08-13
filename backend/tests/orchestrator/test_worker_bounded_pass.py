"""Tests for the scale-to-zero worker's bounded pass (app/orchestrator/
worker.py::run_bounded_pass, run_due_sweeps, _sweep_due, _mark_swept).

This is the mechanism that lets visualsprint-agents run as a Cloud Run
service that scales to zero instead of an always-on process -- Cloud
Scheduler invokes POST /run periodically, and a single pass must (a) drain
whatever's in the job queue, (b) run any sweep whose *durable* due-time has
arrived, and (c) actually return, so the container can scale back down.
Uses the real local Postgres (get_sessionmaker(), same as
tests/test_upload_pipeline.py) because these functions read/write
WorkerSweepState through it directly rather than taking an injected db.
"""

from datetime import UTC, datetime, timedelta

import pytest

import app.orchestrator.worker as worker
from app.db.base import get_sessionmaker
from app.db.models import CaptureSession, Meeting, Org, PipelineJob, WorkerSweepState


@pytest.fixture(autouse=True)
def _cleanup():
    Session = get_sessionmaker()
    with Session() as db:
        db.query(WorkerSweepState).filter(
            WorkerSweepState.name.like("test_sweep%")
        ).delete(synchronize_session=False)
        db.commit()
    yield
    with Session() as db:
        db.query(WorkerSweepState).filter(
            WorkerSweepState.name.like("test_sweep%")
        ).delete(synchronize_session=False)
        db.commit()


def test_sweep_due_when_never_run():
    Session = get_sessionmaker()
    with Session() as db:
        assert worker._sweep_due(db, "test_sweep_never", 300.0, datetime.now(UTC)) is True


def test_sweep_not_due_immediately_after_being_marked():
    Session = get_sessionmaker()
    now = datetime.now(UTC)
    with Session() as db:
        worker._mark_swept(db, "test_sweep_fresh", now)
    with Session() as db:
        assert worker._sweep_due(db, "test_sweep_fresh", 300.0, now) is False


def test_sweep_due_again_once_interval_elapses():
    Session = get_sessionmaker()
    now = datetime.now(UTC)
    with Session() as db:
        worker._mark_swept(db, "test_sweep_elapsed", now)
    later = now + timedelta(seconds=301)
    with Session() as db:
        assert worker._sweep_due(db, "test_sweep_elapsed", 300.0, later) is True


def test_mark_swept_updates_an_existing_row_rather_than_duplicating():
    Session = get_sessionmaker()
    first = datetime.now(UTC)
    second = first + timedelta(seconds=10)
    with Session() as db:
        worker._mark_swept(db, "test_sweep_update", first)
        worker._mark_swept(db, "test_sweep_update", second)
        row = db.get(WorkerSweepState, "test_sweep_update")
        assert row.last_run_at.replace(tzinfo=UTC) == second


async def test_run_due_sweeps_runs_due_and_skips_not_due(monkeypatch):
    calls: list[str] = []

    async def due_sweep(db):
        calls.append("due")

    async def not_due_sweep(db):
        calls.append("not_due")

    Session = get_sessionmaker()
    with Session() as db:
        worker._mark_swept(db, "test_sweep_recent", datetime.now(UTC))

    monkeypatch.setattr(
        worker,
        "_sweep_registry",
        lambda settings: [
            ("test_sweep_stale_or_new", 300.0, due_sweep),
            ("test_sweep_recent", 300.0, not_due_sweep),
        ],
    )

    ran = await worker.run_due_sweeps()

    assert calls == ["due"]
    assert ran == ["test_sweep_stale_or_new"]


async def test_run_bounded_pass_drains_the_queue_and_returns(monkeypatch):
    """Fakes every stage's handler explicitly -- this job auto-chains
    through understand -> verify -> remember -> propose -> report on
    completion, and letting any of those fall through to the real
    _get_llm() singleton would make live, billed Vertex calls from a test
    run. (Caught exactly this: an early version of this test didn't stub
    "report" and made three live 404s against Vertex before this fix.)"""
    monkeypatch.setattr(worker, "_sweep_registry", lambda settings: [])
    processed_ids: list[str] = []

    async def fake_handler(db, job):
        processed_ids.append(job.id)

    for stage in ("understand", "verify", "remember", "propose", "report"):
        monkeypatch.setitem(worker._HANDLERS, stage, fake_handler)

    Session = get_sessionmaker()
    with Session() as db:
        org = Org(name="Bounded Pass Test Org")
        db.add(org)
        db.flush()
        meeting = Meeting(org_id=org.id)
        db.add(meeting)
        db.flush()
        session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
        db.add(session)
        db.flush()
        for _ in range(3):
            db.add(PipelineJob(org_id=org.id, capture_session_id=session.id, stage="understand"))
        db.commit()
        org_id = org.id

    try:
        result = await worker.run_bounded_pass(max_seconds=30.0)
    finally:
        with Session() as db:
            db.query(PipelineJob).filter(PipelineJob.org_id == org_id).delete(
                synchronize_session=False
            )
            db.query(CaptureSession).filter(CaptureSession.org_id == org_id).delete(
                synchronize_session=False
            )
            db.query(Meeting).filter(Meeting.org_id == org_id).delete(synchronize_session=False)
            db.query(Org).filter(Org.id == org_id).delete(synchronize_session=False)
            db.commit()

    # Each of the 3 seeded "understand" jobs auto-chains through
    # verify -> remember -> propose -> report on completion (see
    # app/orchestrator/pipeline.py's STAGES), so 3 seeded jobs x 5 stages
    # each = 15 total PipelineJob rows processed.
    assert result["jobs_processed"] == 15
    assert len(processed_ids) == 15


async def test_run_bounded_pass_returns_promptly_on_an_empty_queue(monkeypatch):
    """The whole point of the scale-to-zero design: an invocation that finds
    nothing to do must not spin for anywhere near `max_seconds`."""
    import time

    monkeypatch.setattr(worker, "_sweep_registry", lambda settings: [])

    start = time.monotonic()
    result = await worker.run_bounded_pass(max_seconds=30.0)
    elapsed = time.monotonic() - start

    assert result["jobs_processed"] == 0
    assert elapsed < 5.0
