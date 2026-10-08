"""Reader-scoped verified evidence and revision checks, shared by HTTP and jobs."""

import hashlib
import json
import re
from dataclasses import dataclass

from sqlalchemy import Select, case, literal, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.db.models import (
    AnswerCitation,
    CaptureSession,
    ChatThread,
    Confidence,
    Customer,
    KnowledgeEvidence,
    KnowledgeItem,
    Meeting,
    MeetingAssignment,
    OrgMember,
    Project,
    ProjectMember,
    Utterance,
)
from app.modules.projects.access import visible_meeting_ids


@dataclass(frozen=True)
class Source:
    id: str
    meeting_id: str
    title: str
    statement: str
    kind: str
    confidence: str
    gap: bool
    fingerprint: str


def scope_allowed(db: Session, thread: ChatThread) -> bool:
    if (
        db.scalar(
            select(OrgMember.id).where(
                OrgMember.org_id == thread.org_id, OrgMember.user_id == thread.creator_id
            )
        )
        is None
    ):
        return False
    if thread.scope_kind == "project":
        return (
            db.scalar(
                select(Project.id)
                .join(ProjectMember, ProjectMember.project_id == Project.id)
                .where(
                    Project.org_id == thread.org_id,
                    Project.deleted_at.is_(None),
                    Project.id == thread.scope_id,
                    ProjectMember.org_id == thread.org_id,
                    ProjectMember.user_id == thread.creator_id,
                )
            )
            is not None
        )
    return (
        thread.scope_kind == "customer"
        and db.scalar(
            select(Customer.id).where(
                Customer.org_id == thread.org_id, Customer.id == thread.scope_id
            )
        )
        is not None
    )


def scope_meetings(thread: ChatThread) -> Select[tuple[str]]:
    query = (
        visible_meeting_ids(thread.org_id, thread.creator_id)
        .join(MeetingAssignment, MeetingAssignment.meeting_id == Meeting.id)
        .join(Project, Project.id == MeetingAssignment.project_id)
        .where(MeetingAssignment.org_id == thread.org_id, Project.org_id == thread.org_id)
    )
    return (
        query.where(Project.id == thread.scope_id)
        if thread.scope_kind == "project"
        else query.where(Project.customer_id == thread.scope_id)
    )


def source_for(db: Session, item: KnowledgeItem, meeting: Meeting) -> Source | None:
    evidence = db.execute(
        select(Utterance.id, Utterance.text, Utterance.start_s, Utterance.end_s)
        .join(KnowledgeEvidence, KnowledgeEvidence.utterance_id == Utterance.id)
        .where(
            KnowledgeEvidence.knowledge_item_id == item.id,
            KnowledgeEvidence.org_id == item.org_id,
            Utterance.org_id == item.org_id,
            Utterance.capture_session_id == item.capture_session_id,
        )
        .order_by(Utterance.id)
        .limit(25)
    ).all()
    if not evidence or item.confidence not in {Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED}:
        return None
    material = [
        item.id,
        item.statement,
        item.confidence.value,
        item.lifecycle_state.value,
        item.overlaps_coverage_gap,
        meeting.id,
        meeting.title,
        [list(row) for row in evidence],
    ]
    digest = hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()
    return Source(
        item.id,
        meeting.id,
        meeting.title,
        item.statement,
        item.type.value,
        item.confidence.value,
        item.overlaps_coverage_gap,
        digest,
    )


def sources(db: Session, thread: ChatThread, question: str) -> list[Source]:
    # Filter permissions before ranking and limiting. No whole-history prompt concatenation.
    terms = list(dict.fromkeys(re.findall(r"[a-z0-9]{3,}", question.lower())))[:20]
    rank: ColumnElement[int] = literal(0)
    for term in terms:
        rank = rank + case((KnowledgeItem.statement.ilike(f"%{term}%"), 1), else_=0)
    query = (
        select(KnowledgeItem, Meeting)
        .join(CaptureSession, CaptureSession.id == KnowledgeItem.capture_session_id)
        .join(Meeting, Meeting.id == CaptureSession.meeting_id)
        .where(
            KnowledgeItem.org_id == thread.org_id,
            CaptureSession.org_id == thread.org_id,
            Meeting.id.in_(scope_meetings(thread)),
            KnowledgeItem.confidence.in_({Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED}),
        )
    )
    if terms:
        query = query.order_by(rank.desc())
    rows = db.execute(query.order_by(Meeting.created_at.desc(), KnowledgeItem.id).limit(200)).all()
    result: list[Source] = []
    size = 0
    for item, meeting in rows:
        source = source_for(db, item, meeting)
        if source and len(source.statement) <= 4000 and size + len(source.statement) <= 32000:
            result.append(source)
            size += len(source.statement)
            if len(result) >= 60:
                break
    return result


def citation_current(db: Session, thread: ChatThread, citation: AnswerCitation) -> bool:
    if db.scalar(scope_meetings(thread).where(Meeting.id == citation.meeting_id)) is None:
        return False
    if citation.source_hash is None:
        return True  # Legacy answers retain their existing access checks.
    item = db.get(KnowledgeItem, citation.knowledge_item_id) if citation.knowledge_item_id else None
    meeting = db.get(Meeting, citation.meeting_id)
    if item is None or meeting is None or item.org_id != thread.org_id:
        return False
    session = db.get(CaptureSession, item.capture_session_id)
    if session is None or session.meeting_id != meeting.id or session.org_id != thread.org_id:
        return False
    source = source_for(db, item, meeting)
    return source is not None and source.fingerprint == citation.source_hash
