"""Aggregate KnowledgeItems for a project or customer into a SummaryVersion.

The summary is keyed by the authorized meeting set and its source revision, so
processing, corrections and assignment changes invalidate cached memory. Deterministic software owns this
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
    Customer,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    MeetingAssignment,
    Project,
    ProjectMember,
    SummaryState,
    SummaryVersion,
)

log = structlog.get_logger()

_INCLUDED_CONFIDENCE = {Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED}
_ACTIVE_STATES = {LifecycleState.NEW, LifecycleState.RECURRING, LifecycleState.REOPENED}


def _meeting_ids_for_project(db: Session, org_id: str, project_id: str) -> list[str]:
    rows = (
        db.execute(
            select(MeetingAssignment.meeting_id).where(
                MeetingAssignment.org_id == org_id,
                MeetingAssignment.project_id == project_id,
            )
        )
        .scalars()
        .all()
    )
    return sorted(rows)


def _meeting_ids_for_customer(
    db: Session, org_id: str, customer_id: str, user_id: str
) -> list[str]:
    """Resolve the reader's source set before aggregation or cache lookup."""

    project_ids = (
        db.execute(
            select(Project.id)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(
                Project.org_id == org_id,
                Project.customer_id == customer_id,
                ProjectMember.org_id == org_id,
                ProjectMember.user_id == user_id,
            )
        )
        .scalars()
        .all()
    )

    if not project_ids:
        return []

    rows = (
        db.execute(
            select(MeetingAssignment.meeting_id).where(
                MeetingAssignment.org_id == org_id,
                MeetingAssignment.project_id.in_(project_ids),
            )
        )
        .scalars()
        .all()
    )
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

    session_ids = (
        db.execute(
            select(CaptureSession.id).where(
                CaptureSession.org_id == org_id,
                CaptureSession.meeting_id.in_(meeting_ids),
            )
        )
        .scalars()
        .all()
    )

    if not session_ids:
        return {
            "decisions": [],
            "commitments": [],
            "open_questions": [],
            "blockers": [],
            "context_summary": "No processed capture sessions for assigned meetings.",
        }

    items = (
        db.execute(
            select(KnowledgeItem).where(
                KnowledgeItem.org_id == org_id,
                KnowledgeItem.capture_session_id.in_(session_ids),
                KnowledgeItem.confidence.in_([c.value for c in _INCLUDED_CONFIDENCE]),
                KnowledgeItem.lifecycle_state.in_([s.value for s in _ACTIVE_STATES]),
            )
        )
        .scalars()
        .all()
    )

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
            "owner_person_id": item.owner_person_id,
            "due_at": item.due_at.isoformat() if item.due_at else None,
            "coverage_gap": item.overlaps_coverage_gap,
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


def _source_revision(db: Session, org_id: str, meeting_ids: list[str]) -> str:
    """Invalidate on evidence/correction changes as well as meeting assignment.

    The old meeting-ID-only hash cached empty memory forever when processing later
    finished. Source rows participate, so changing a claim, transcript or coverage
    does not serve a previously generated summary under a new source revision.
    """
    from app.db.models import CaptureSession, CoverageInterval, KnowledgeEvidence, Utterance

    sessions = select(CaptureSession.id).where(
        CaptureSession.org_id == org_id, CaptureSession.meeting_id.in_(meeting_ids)
    )
    items = select(KnowledgeItem.id).where(
        KnowledgeItem.org_id == org_id, KnowledgeItem.capture_session_id.in_(sessions)
    )
    sources: dict[str, Any] = {"meetings": sorted(meeting_ids), "schema": "authorized-memory-v2"}
    for model, condition in (
        (CaptureSession, CaptureSession.id.in_(sessions)),
        (KnowledgeItem, KnowledgeItem.id.in_(items)),
        (Utterance, Utterance.capture_session_id.in_(sessions)),
        (CoverageInterval, CoverageInterval.capture_session_id.in_(sessions)),
        (KnowledgeEvidence, KnowledgeEvidence.knowledge_item_id.in_(items)),
    ):
        rows = db.scalars(
            select(model).where(model.org_id == org_id, condition).order_by(model.id)
        ).all()
        sources[model.__tablename__] = [
            {
                column.name: str(getattr(row, column.name))
                for column in model.__table__.columns
                if column.name != "embedding"
            }
            for row in rows
        ]
    return hashlib.sha256(
        json.dumps(sources, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def current_memory(
    db: Session, org_id: str, scope_kind: str, scope_id: str, user_id: str | None = None
) -> SummaryVersion:
    """Build/cache the current authorized revision using a caller-owned session.

    Customer memory always requires a reader. The scope lock serializes publication;
    each version is keyed by its complete source set, never by 'latest customer'.
    """
    if scope_kind == "project":
        scope = db.scalar(
            select(Project)
            .where(Project.org_id == org_id, Project.id == scope_id)
            .with_for_update()
        )
        if scope is None:
            raise LookupError("project not found")
        if (
            user_id is not None
            and db.scalar(
                select(ProjectMember.id).where(
                    ProjectMember.org_id == org_id,
                    ProjectMember.project_id == scope_id,
                    ProjectMember.user_id == user_id,
                )
            )
            is None
        ):
            raise LookupError("project not found")
        meeting_ids = _meeting_ids_for_project(db, org_id, scope_id)
    elif scope_kind == "customer":
        if user_id is None:
            raise ValueError("customer memory requires an authorized reader")
        customer_scope = db.scalar(
            select(Customer)
            .where(Customer.org_id == org_id, Customer.id == scope_id)
            .with_for_update()
        )
        if customer_scope is None:
            raise LookupError("customer not found")
        meeting_ids = _meeting_ids_for_customer(db, org_id, scope_id, user_id)
    else:
        raise ValueError("unknown memory scope")
    revision = _source_revision(db, org_id, meeting_ids)
    existing = db.scalar(
        select(SummaryVersion).where(
            SummaryVersion.org_id == org_id,
            SummaryVersion.scope_kind == scope_kind,
            SummaryVersion.scope_id == scope_id,
            SummaryVersion.input_revision_hash == revision,
            SummaryVersion.state == SummaryState.READY,
        )
    )
    if existing is not None:
        return existing
    summary = SummaryVersion(
        org_id=org_id,
        scope_kind=scope_kind,
        scope_id=scope_id,
        input_revision_hash=revision,
        state=SummaryState.READY,
        structured_summary=_build_structured_summary(db, org_id, meeting_ids),
        source_meeting_ids=meeting_ids,
    )
    db.add(summary)
    db.commit()
    db.refresh(summary)
    return summary


def rebuild_project_memory(
    session_factory: Callable[[], Session],
    org_id: str,
    project_id: str,
) -> SummaryVersion:
    """Rebuild or retrieve a SummaryVersion for a project.

    Idempotent: if the authorized sources haven't changed (same hash), returns
    the existing READY row.  Creates a new READY row otherwise.
    """
    db = session_factory()
    try:
        return current_memory(db, org_id, "project", project_id)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def rebuild_customer_memory(
    session_factory: Callable[[], Session],
    org_id: str,
    customer_id: str,
    user_id: str,
) -> SummaryVersion:
    """Rebuild or retrieve a SummaryVersion for a customer (all visible projects)."""
    db = session_factory()
    try:
        return current_memory(db, org_id, "customer", customer_id, user_id)
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
