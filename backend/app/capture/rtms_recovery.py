"""Disclosure and recovery for Mode A1 (Zoom RTMS) streams that never finish.

An RTMS capture lives in the memory of one API container for the duration of
the meeting. That container can be recycled mid-meeting, the `rtms_stopped`
webhook can be load-balanced to a different instance, or the stop event can
simply never arrive. Any of those loses the audio -- unavoidably, until RTMS
moves off the scale-to-zero API service onto the always-on host Mode B needs
anyway (docs/03-capture.md).

What is avoidable is losing it *silently*, which is what used to happen: the
CaptureSession stayed in a running state forever and no `coverage_interval`
row was ever written, so the meeting simply had no record that anything was
missed. CLAUDE.md rule 6 is explicit that a gap is data, not silence -- and a
capture that produced nothing at all is the largest gap there is.
"""

from datetime import UTC, datetime, timedelta

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import CaptureSession, CaptureState, CoverageInterval, CoverageStatus

log = structlog.get_logger()

# States an A1 session can sit in while its stream is still believed live.
LIVE_STATES = (CaptureState.SCHEDULED, CaptureState.ACQUIRING)


def mark_stream_lost(db: Session, session: CaptureSession, *, reason: str) -> CoverageInterval:
    """Disclose an unrecoverable RTMS capture as a full-session coverage gap.

    Idempotent: re-running against an already-disclosed session returns the
    existing row rather than stacking duplicates, so a retried webhook or a
    second watchdog pass is harmless.
    """
    existing = db.execute(
        select(CoverageInterval).where(
            CoverageInterval.capture_session_id == session.id,
            CoverageInterval.modality == "audio",
            CoverageInterval.reason == reason,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    gap = CoverageInterval(
        org_id=session.org_id,
        capture_session_id=session.id,
        start_s=0.0,
        # The true duration is unknown -- nothing was captured to measure. 0.0
        # marks "the whole session", which the report renders as a total gap
        # rather than implying a specific missing span.
        end_s=0.0,
        modality="audio",
        status=CoverageStatus.MISSING,
        reason=reason,
    )
    db.add(gap)
    session.state = CaptureState.FAILED
    session.error = f"rtms capture lost: {reason}"
    db.flush()
    log.warning("rtms.stream_lost", session=session.id, reason=reason)
    return gap


def sweep_orphaned_rtms_streams(db: Session, *, max_meeting_hours: float = 6.0) -> list[str]:
    """Disclose A1 sessions whose stream never finalized.

    A meeting longer than `max_meeting_hours` is not plausible; a session
    still sitting in a live state past that has lost its container. Returns
    the ids disclosed.
    """
    cutoff = datetime.now(UTC) - timedelta(hours=max_meeting_hours)
    stale = (
        db.execute(
            select(CaptureSession).where(
                CaptureSession.mode == "A1",
                CaptureSession.rtms_stream_id.isnot(None),
                CaptureSession.state.in_(LIVE_STATES),
                CaptureSession.created_at < cutoff,
            )
        )
        .scalars()
        .all()
    )
    disclosed: list[str] = []
    for session in stale:
        mark_stream_lost(db, session, reason="rtms_stream_never_finalized")
        disclosed.append(session.id)
    if disclosed:
        db.commit()
    return disclosed
