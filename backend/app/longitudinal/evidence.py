"""Deterministic evidence assembly, candidate selection, and grounding checks."""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents.longitudinal_common import LongitudinalEvidenceItem
from app.agents.progress import ProgressInput, ProgressPeriod
from app.db.models import (
    CaptureSession,
    Confidence,
    CoverageInterval,
    EdgeKind,
    KnowledgeEdge,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Meeting,
    Utterance,
    WorkEvidence,
)

COUNTED_CONFIDENCES = {Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED}
REPETITION_SIMILARITY = 0.72


@dataclass(frozen=True)
class EvidenceCorpus:
    items: list[LongitudinalEvidenceItem]
    evidence_hash: str
    last_evidence_at: datetime | None
    coverage_disclosure: dict


def _tokens(value: str) -> set[str]:
    return set(re.findall(r"[^\W_]+", value.casefold(), flags=re.UNICODE))


def _cosine(left: list[float] | None, right: list[float] | None) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    norm = sum(a * a for a in left) ** 0.5 * sum(b * b for b in right) ** 0.5
    return dot / norm if norm else 0.0


def _semantic_similarity(left: KnowledgeItem, right: KnowledgeItem) -> float:
    vector_score = _cosine(left.embedding, right.embedding)
    left_tokens, right_tokens = _tokens(left.statement), _tokens(right.statement)
    lexical = len(left_tokens & right_tokens) / len(left_tokens | right_tokens) if left_tokens | right_tokens else 0.0
    return max(vector_score, lexical)


def _meeting_for_item(db: Session, item: KnowledgeItem) -> Meeting | None:
    capture = db.get(CaptureSession, item.capture_session_id)
    return db.get(Meeting, capture.meeting_id) if capture else None


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def assemble_person_evidence(
    db: Session, org_id: str, person_id: str, period_start: datetime, period_end: datetime
) -> EvidenceCorpus:
    rows = db.execute(
        select(KnowledgeItem).where(
            KnowledgeItem.org_id == org_id,
            KnowledgeItem.owner_person_id == person_id,
            KnowledgeItem.confidence.in_(COUNTED_CONFIDENCES),
        )
    ).scalars().all()
    selected: list[tuple[KnowledgeItem, Meeting]] = []
    for item in rows:
        meeting = _meeting_for_item(db, item)
        occurred_at = _aware(meeting.scheduled_start or meeting.created_at) if meeting else None
        if meeting and occurred_at and _aware(period_start) <= occurred_at <= _aware(period_end):
            selected.append((item, meeting))

    item_ids = [item.id for item, _meeting in selected]
    edges = db.execute(
        select(KnowledgeEdge).where(
            KnowledgeEdge.org_id == org_id,
            (KnowledgeEdge.from_item_id.in_(item_ids) | KnowledgeEdge.to_item_id.in_(item_ids)),
        )
    ).scalars().all() if item_ids else []
    rationales: dict[str, list[str]] = defaultdict(list)
    blockers: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        if edge.from_item_id in item_ids:
            rationales[edge.from_item_id].append(edge.rationale)
        if edge.to_item_id in item_ids:
            rationales[edge.to_item_id].append(edge.rationale)
        if edge.kind == EdgeKind.BLOCKS and edge.to_item_id in item_ids:
            blockers[edge.to_item_id].append(edge.from_item_id)
    statuses: dict[str, list[str]] = defaultdict(list)
    if item_ids:
        for work in db.execute(
            select(WorkEvidence).where(WorkEvidence.knowledge_item_id.in_(item_ids))
        ).scalars().all():
            statuses[work.knowledge_item_id].append(work.status.value)

    items = [
        LongitudinalEvidenceItem(
            id=item.id,
            type=item.type,
            statement=item.statement,
            lifecycle_state=item.lifecycle_state,
            confidence=item.confidence,
            meeting_at=_aware(meeting.scheduled_start or meeting.created_at),
            due_at=item.due_at,
            edge_rationales=sorted(rationales[item.id]),
            blocker_item_ids=sorted(blockers[item.id]),
            work_statuses=statuses[item.id],
        )
        for item, meeting in sorted(
            selected, key=lambda row: _aware(row[1].scheduled_start or row[1].created_at)
        )
    ]
    serialized = json.dumps([item.model_dump(mode="json") for item in items], sort_keys=True)
    utterances = db.execute(
        select(Utterance).where(Utterance.org_id == org_id, Utterance.person_id == person_id)
    ).scalars().all()
    session_ids = {item.capture_session_id for item, _meeting in selected}
    gaps = db.execute(
        select(CoverageInterval).where(CoverageInterval.capture_session_id.in_(session_ids))
    ).scalars().all() if session_ids else []
    low = sum(
        utterance.attribution_confidence < 0.75 or utterance.asr_confidence < 0.60
        for utterance in utterances
    )
    return EvidenceCorpus(
        items=items,
        evidence_hash=hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
        last_evidence_at=max((item.meeting_at for item in items), default=None),
        coverage_disclosure={
            "utterance_count": len(utterances),
            "low_confidence_utterance_count": low,
            "coverage_gap_count": len(gaps),
        },
    )


def detect_repetition_candidates(
    db: Session, org_id: str, person_id: str, corpus: EvidenceCorpus
) -> list[list[LongitudinalEvidenceItem]]:
    source = [
        item for item in corpus.items
        if item.type in {KnowledgeType.COMMITMENT, KnowledgeType.BLOCKER}
        and item.lifecycle_state not in {LifecycleState.RESOLVED, LifecycleState.SUPERSEDED}
        and not item.blocker_item_ids
        and "closed" not in item.work_statuses
    ]
    model_rows = {
        item.id: db.get(KnowledgeItem, item.id) for item in source
    }
    parent = {item.id: item.id for item in source}

    def find(item_id: str) -> str:
        while parent[item_id] != item_id:
            parent[item_id] = parent[parent[item_id]]
            item_id = parent[item_id]
        return item_id

    def union(left: str, right: str) -> None:
        a, b = find(left), find(right)
        if a != b:
            parent[b] = a

    for index, left in enumerate(source):
        for right in source[index + 1:]:
            left_row, right_row = model_rows[left.id], model_rows[right.id]
            if (
                left_row
                and right_row
                and left_row.capture_session_id != right_row.capture_session_id
                and _semantic_similarity(left_row, right_row) >= REPETITION_SIMILARITY
            ):
                union(left.id, right.id)
    groups: dict[str, list[LongitudinalEvidenceItem]] = defaultdict(list)
    for item in source:
        groups[find(item.id)].append(item)
    return [sorted(group, key=lambda item: item.meeting_at) for group in groups.values() if len(group) >= 2]


def build_progress_input(person_id: str, corpus: EvidenceCorpus) -> ProgressInput:
    commitments = [item for item in corpus.items if item.type == KnowledgeType.COMMITMENT]
    if not commitments:
        return ProgressInput(person_id=person_id, periods=[])
    ordered = sorted(commitments, key=lambda item: item.meeting_at)
    midpoint = ordered[0].meeting_at + (ordered[-1].meeting_at - ordered[0].meeting_at) / 2
    buckets = [("earlier", [item for item in ordered if item.meeting_at <= midpoint]), ("later", [item for item in ordered if item.meeting_at > midpoint])]
    periods = [
        ProgressPeriod(
            label=label,
            meeting_count=len({item.meeting_at.date() for item in items}),
            commitment_ids=[item.id for item in items],
            delivered_ids=[item.id for item in items if item.lifecycle_state == LifecycleState.RESOLVED],
            blocked_ids=[item.id for item in items if item.blocker_item_ids],
            coverage_gap_count=int(corpus.coverage_disclosure.get("coverage_gap_count", 0)),
        )
        for label, items in buckets
    ]
    return ProgressInput(person_id=person_id, periods=periods)


def validate_grounding(db: Session, org_id: str, evidence_item_ids: list[str]) -> bool:
    if not evidence_item_ids or len(set(evidence_item_ids)) != len(evidence_item_ids):
        return False
    found = db.execute(
        select(KnowledgeItem.id).where(
            KnowledgeItem.org_id == org_id, KnowledgeItem.id.in_(evidence_item_ids)
        )
    ).scalars().all()
    return set(found) == set(evidence_item_ids)


def utc_period(days: int = 90, now: datetime | None = None) -> tuple[datetime, datetime]:
    from datetime import timedelta

    end = now or datetime.now(UTC)
    return end - timedelta(days=days), end
