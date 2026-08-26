"""Unit tests for RTMS orphaned-stream recovery (app/capture/rtms_recovery.py).

Found with zero test coverage during the RTMS/Teams/calendar capture audit --
this is the module responsible for CLAUDE.md rule 6 (a capture gap is data,
not silence) specifically for Mode A1 sessions whose stream never finalized
because the API container that held it was recycled or the stop webhook
landed elsewhere. In-memory SQLite, no real Postgres needed.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.capture.rtms_recovery import mark_stream_lost, sweep_orphaned_rtms_streams
from app.db.base import Base
from app.db.models import (
    CaptureSession,
    CaptureState,
    CoverageInterval,
    CoverageStatus,
    Meeting,
    Org,
)


def _make_db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    return Session()


def _make_session(
    db,
    *,
    mode: str = "A1",
    state: CaptureState = CaptureState.ACQUIRING,
    rtms_stream_id: str | None = "stream-1",
    created_at: datetime | None = None,
) -> CaptureSession:
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    meeting = Meeting(org_id=org.id, title="Standup", platform="zoom")
    db.add(meeting)
    db.flush()
    session = CaptureSession(
        org_id=org.id,
        meeting_id=meeting.id,
        mode=mode,
        state=state,
        rtms_stream_id=rtms_stream_id,
    )
    if created_at is not None:
        session.created_at = created_at
    db.add(session)
    db.flush()
    return session


def test_mark_stream_lost_writes_a_full_session_coverage_gap():
    db = _make_db()
    session = _make_session(db)

    gap = mark_stream_lost(db, session, reason="rtms_stream_never_finalized")

    assert gap.modality == "audio"
    assert gap.status == CoverageStatus.MISSING
    assert gap.start_s == 0.0
    assert gap.end_s == 0.0
    assert gap.reason == "rtms_stream_never_finalized"
    assert session.state == CaptureState.FAILED
    assert "rtms_stream_never_finalized" in (session.error or "")


def test_mark_stream_lost_is_idempotent_on_retry():
    db = _make_db()
    session = _make_session(db)

    first = mark_stream_lost(db, session, reason="rtms_stream_never_finalized")
    second = mark_stream_lost(db, session, reason="rtms_stream_never_finalized")

    assert first.id == second.id
    count = db.execute(
        select(CoverageInterval).where(CoverageInterval.capture_session_id == session.id)
    ).scalars().all()
    assert len(count) == 1


def test_mark_stream_lost_allows_distinct_reasons_as_separate_gaps():
    db = _make_db()
    session = _make_session(db)

    mark_stream_lost(db, session, reason="rtms_stream_never_finalized")
    mark_stream_lost(db, session, reason="container_recycled")

    count = db.execute(
        select(CoverageInterval).where(CoverageInterval.capture_session_id == session.id)
    ).scalars().all()
    assert len(count) == 2


def test_sweep_discloses_a1_session_stuck_past_the_cutoff():
    db = _make_db()
    stale = _make_session(
        db, created_at=datetime.now(UTC) - timedelta(hours=7)
    )

    disclosed = sweep_orphaned_rtms_streams(db, max_meeting_hours=6.0)

    assert disclosed == [stale.id]
    db.refresh(stale)
    assert stale.state == CaptureState.FAILED


def test_sweep_ignores_sessions_within_the_time_window():
    db = _make_db()
    fresh = _make_session(
        db, created_at=datetime.now(UTC) - timedelta(hours=1)
    )

    disclosed = sweep_orphaned_rtms_streams(db, max_meeting_hours=6.0)

    assert disclosed == []
    db.refresh(fresh)
    assert fresh.state == CaptureState.ACQUIRING


def test_sweep_ignores_non_a1_sessions():
    db = _make_db()
    _make_session(
        db, mode="B", created_at=datetime.now(UTC) - timedelta(hours=7)
    )

    disclosed = sweep_orphaned_rtms_streams(db, max_meeting_hours=6.0)

    assert disclosed == []


def test_sweep_ignores_sessions_without_a_stream_id():
    db = _make_db()
    _make_session(
        db, rtms_stream_id=None, created_at=datetime.now(UTC) - timedelta(hours=7)
    )

    disclosed = sweep_orphaned_rtms_streams(db, max_meeting_hours=6.0)

    assert disclosed == []


def test_sweep_ignores_sessions_already_in_a_terminal_state():
    db = _make_db()
    _make_session(
        db, state=CaptureState.DONE, created_at=datetime.now(UTC) - timedelta(hours=7)
    )

    disclosed = sweep_orphaned_rtms_streams(db, max_meeting_hours=6.0)

    assert disclosed == []
