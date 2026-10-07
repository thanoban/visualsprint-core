"""Aggregate KnowledgeItems for a project or customer into a SummaryVersion.

The summary is keyed by a hash of the meeting IDs in scope so it can be
incremented when new meetings are assigned.  Deterministic software owns this
aggregation — no LLM is called here; the structured_summary is built from
already-verified KnowledgeItem rows only.

Architecture rule: raw transcript never enters structured_summary.  Only
verified claims (Confidence.VERIFIED or PARTIALLY_SUPPORTED) are included.
"""

import hashlib
import json
from collections.abc import Callable
from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    Confidence,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Meeting,
    MeetingAssignment,
    SummaryState,
    SummaryVersion,
)

log = structlog.get_logger()

_INCLUDED_CONFIDENCE = {Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED}
_ACTIVE_STATES = {LifecycleState.NEW, LifecycleState.RECURRING, LifecycleState.REOPENED}


def _meeting_ids_for_project(db: Session, org_id: str, project_id: str) -> list[str]:
    rows = db.execute(
        select(MeetingAssignment.meeting_id).where(
            MeetingAssignment.org_id == org_id,
            MeetingAssignment.project_id == project_id,
        )
    ).scalars().all()
    return sorted(rows)


def _meeting_ids_for_customer(db: Session, org_id: str, customer_id: str) -> list[str]:
    """Return meeting IDs from all projects assigned to this customer."""
    from app.db.models import Project

    project_ids = db.execute(
        select(Project.id).where(
            Project.org_id == org_id,
            Project.customer_id == customer_id,
        )
    ).scalars().all()

    if not project_ids:
        return []

    rows = db.execute(
        select(MeetingAssignment.meeting_id).where(
            MeetingAssignment.org_id == org_id,
            MeetingAssignment.project_id.in_(project_ids),
        )
    ).scalars().all()
    return sorted(set(rows))


def _revision_hash(meeting_ids: list[str]) -> str:
    payload = json.dumps(sorted(meeting_ids), separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _build_structured_summary(
    db: Session,
    org_id: str,
    meeting_ids: list[str],
) -> dict[str, Any]:
    """Aggregate verified KnowledgeItems into typed lists.  No raw transcript."""
    if not meeting_ids:
        return {
            "decisions": [],
            "commitments": [],
            "open_questions": [],
            "blockers": [],
            "context_summary": "No meetings assigned yet.",
        }

    # Fetch capture sessions associated with these meetings.
    from app.db.models import CaptureSession

    session_ids = db.execute(
        select(CaptureSession.id).where(
            CaptureSession.org_id == org_id,
            CaptureSession.meeting_id.in_(meeting_ids),
        )
    ).scalars().all()

    if not session_ids:
        return {
            "decisions": [],
            "commitments": [],
            "open_questions": [],
            "blockers": [],
            "context_summary": "No processed capture sessions for assigned meetings.",
        }

    items = db.execute(
        select(KnowledgeItem).where(
            KnowledgeItem.org_id == org_id,
            KnowledgeItem.capture_session_id.in_(session_ids),
            KnowledgeItem.confidence.in_([c.value for c in _INCLUDED_CONFIDENCE]),
            KnowledgeItem.lifecycle_state.in_([s.value for s in _ACTIVE_STATES]),
        )
    ).scalars().all()

    buckets: dict[str, list[dict[str, Any]]] = {
        "decisions": [],
        "commitments": [],
        "open_questions": [],
        "blockers": [],
    }
    for item in items:
        record: dict[str, Any] = {
            "id": item.id,
            "statement": item.statement,
            "confidence": item.confidence,
            "lifecycle_state": item.lifecycle_state,
            "capture_session_id": item.capture_session_id,
        }
        if item.type == KnowledgeType.DECISION:
            buckets["decisions"].append(record)
        elif item.type == KnowledgeType.COMMITMENT:
            buckets["commitments"].append(record)
        elif item.type == KnowledgeType.QUESTION:
            buckets["open_questions"].append(record)
        elif item.type == KnowledgeType.BLOCKER:
            buckets["blockers"].append(record)

    total = sum(len(v) for v in buckets.values())
    return {
        **buckets,
        "context_summary": (
            f"{total} verified knowledge items across {len(meeting_ids)} meeting(s)."
        ),
    }


def rebuild_project_memory(
    session_factory: Callable[[], Session],
    org_id: str,
    project_id: str,
) -> SummaryVersion:
    """Rebuild or retrieve a SummaryVersion for a project.

    Idempotent: if the current meeting set hasn't changed (same hash), returns
    the existing READY row.  Creates a new READY row otherwise.
    """
    db = session_factory()
    try:
        meeting_ids = _meeting_ids_for_project(db, org_id, project_id)
        rev_hash = _revision_hash(meeting_ids)

        existing = db.execute(
            select(SummaryVersion).where(
                SummaryVersion.scope_kind == "project",
                SummaryVersion.scope_id == project_id,
                SummaryVersion.input_revision_hash == rev_hash,
                SummaryVersion.state == SummaryState.READY,
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing

        structured = _build_structured_summary(db, org_id, meeting_ids)
        sv = SummaryVersion(
            org_id=org_id,
            scope_kind="project",
            scope_id=project_id,
            input_revision_hash=rev_hash,
            state=SummaryState.READY,
            structured_summary=structured,
            source_meeting_ids=meeting_ids,
        )
        db.add(sv)
        db.commit()
        db.refresh(sv)
        log.info("project_memory_rebuilt", project_id=project_id, meetings=len(meeting_ids))
        return sv
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def rebuild_customer_memory(
    session_factory: Callable[[], Session],
    org_id: str,
    customer_id: str,
) -> SummaryVersion:
    """Rebuild or retrieve a SummaryVersion for a customer (all visible projects)."""
    db = session_factory()
    try:
        meeting_ids = _meeting_ids_for_customer(db, org_id, customer_id)
        rev_hash = _revision_hash(meeting_ids)

        existing = db.execute(
            select(SummaryVersion).where(
                SummaryVersion.scope_kind == "customer",
                SummaryVersion.scope_id == customer_id,
                SummaryVersion.input_revision_hash == rev_hash,
                SummaryVersion.state == SummaryState.READY,
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing

        structured = _build_structured_summary(db, org_id, meeting_ids)
        sv = SummaryVersion(
            org_id=org_id,
            scope_kind="customer",
            scope_id=customer_id,
            input_revision_hash=rev_hash,
            state=SummaryState.READY,
            structured_summary=structured,
            source_meeting_ids=meeting_ids,
        )
        db.add(sv)
        db.commit()
        db.refresh(sv)
        log.info("customer_memory_rebuilt", customer_id=customer_id, meetings=len(meeting_ids))
        return sv
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def latest_summary(
    db: Session,
    scope_kind: str,
    scope_id: str,
) -> SummaryVersion | None:
    """Return the latest READY SummaryVersion for a scope, or None."""
    return db.execute(
        select(SummaryVersion)
        .where(
            SummaryVersion.scope_kind == scope_kind,
            SummaryVersion.scope_id == scope_id,
            SummaryVersion.state == SummaryState.READY,
        )
        .order_by(SummaryVersion.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
