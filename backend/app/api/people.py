"""Per-person accountability surfaces without scores or rankings."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependency import require_org_member
from app.db.base import get_db
from app.db.models import (
    Confidence,
    EdgeKind,
    FindingAuditStatus,
    KnowledgeEdge,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    LongitudinalFinding,
    LongitudinalState,
    Meeting,
    Person,
    PersonAnalysisRun,
    Utterance,
)

router = APIRouter(prefix="/api/v1/orgs/{org_id}/people", tags=["people"])

COUNTED_CONFIDENCES = {Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED}


class PersonListItem(BaseModel):
    id: str
    display_name: str
    email: str | None = None
    user_id: str | None = None
    open_commitments: int
    overdue_commitments: int


class BlockerRef(BaseModel):
    id: str
    statement: str
    confidence: str


class PersonKnowledgeOut(BaseModel):
    id: str
    type: str
    statement: str
    lifecycle_state: str
    confidence: str
    due_at: str | None = None
    owner_source: str | None = None
    owner_confidence: float | None = None
    meeting_id: str
    capture_session_id: str
    meeting_title: str
    occurred_at: str
    coverage_gap: bool
    evidence_url: str
    blockers: list[BlockerRef] = []


class CoverageDisclosure(BaseModel):
    utterance_count: int
    low_confidence_or_gap_count: int
    excluded_item_count: int


class PersonDetail(BaseModel):
    id: str
    display_name: str
    email: str | None = None
    user_id: str | None = None
    commitments: list[PersonKnowledgeOut]
    decisions_authored: list[PersonKnowledgeOut]
    coverage: CoverageDisclosure


class LifecycleHop(BaseModel):
    edge_id: str
    from_item_id: str
    to_item_id: str
    kind: str
    rationale: str
    from_statement: str
    from_meeting_title: str
    from_occurred_at: str
    evidence_url: str


class InteractionNode(BaseModel):
    person_id: str
    display_name: str


class InteractionEdge(BaseModel):
    from_person_id: str
    to_person_id: str
    kind: str
    weight: int
    evidence_url: str


class InteractionMap(BaseModel):
    nodes: list[InteractionNode]
    edges: list[InteractionEdge]


class LongitudinalFindingOut(BaseModel):
    id: str
    kind: str
    statement: str
    confidence: str
    audit_status: str
    sample_size: int
    evidence: list[PersonKnowledgeOut]


class TrendPoint(BaseModel):
    period: str
    delivered: int
    total: int
    coverage_gap: bool
    evidence_url: str | None = None


class FunnelOut(BaseModel):
    stated: int
    open: int
    recurring: int
    blocked: int
    delivered: int


class PersonAnalysisOut(BaseModel):
    available: bool
    run_id: str | None = None
    state: str | None = None
    summary: str = ""
    coverage: dict = {}
    findings: list[LongitudinalFindingOut] = []
    commitment_timeline: list[PersonKnowledgeOut] = []
    follow_through_trend: list[TrendPoint] = []
    recurrence_heat_strip: list[list[PersonKnowledgeOut]] = []
    decision_evolution: list[LifecycleHop] = []
    commitment_funnel: FunnelOut | None = None
    status_distribution: dict[str, int] = {}


def _get_person_or_404(db: Session, org_id: str, person_id: str) -> Person:
    person = db.get(Person, person_id)
    if person is None or person.org_id != org_id:
        raise HTTPException(404, "person not found")
    return person


def _meeting_for_item(db: Session, item: KnowledgeItem) -> Meeting:
    from app.db.models import CaptureSession

    session = db.get(CaptureSession, item.capture_session_id)
    meeting = db.get(Meeting, session.meeting_id) if session else None
    if meeting is None:
        raise HTTPException(500, "knowledge item has no meeting")
    return meeting


def _blockers_for_item(db: Session, item: KnowledgeItem) -> list[BlockerRef]:
    rows = db.execute(
        select(KnowledgeEdge, KnowledgeItem)
        .join(KnowledgeItem, KnowledgeItem.id == KnowledgeEdge.from_item_id)
        .where(
            KnowledgeEdge.to_item_id == item.id,
            KnowledgeEdge.kind == EdgeKind.BLOCKS,
            KnowledgeItem.type == KnowledgeType.BLOCKER,
            KnowledgeItem.confidence.in_(COUNTED_CONFIDENCES),
        )
    ).all()
    return [
        BlockerRef(id=blocker.id, statement=blocker.statement, confidence=blocker.confidence.value)
        for _edge, blocker in rows
    ]


def _item_out(db: Session, item: KnowledgeItem) -> PersonKnowledgeOut:
    meeting = _meeting_for_item(db, item)
    occurred_at = meeting.scheduled_start or meeting.created_at
    return PersonKnowledgeOut(
        id=item.id,
        type=item.type.value,
        statement=item.statement,
        lifecycle_state=item.lifecycle_state.value,
        confidence=item.confidence.value,
        due_at=item.due_at.isoformat() if item.due_at else None,
        owner_source=item.owner_source,
        owner_confidence=item.owner_attribution_confidence,
        meeting_id=meeting.id,
        capture_session_id=item.capture_session_id,
        meeting_title=meeting.title or "Untitled meeting",
        occurred_at=occurred_at.isoformat(),
        coverage_gap=item.overlaps_coverage_gap,
        evidence_url=f"/meetings/{item.capture_session_id}/report?item={item.id}",
        blockers=_blockers_for_item(db, item),
    )


def _coverage_for_person(db: Session, person: Person) -> CoverageDisclosure:
    utterances = (
        db.execute(select(Utterance).where(Utterance.person_id == person.id)).scalars().all()
    )
    low = [u for u in utterances if u.attribution_confidence < 0.75 or u.asr_confidence < 0.60]
    excluded = (
        db.execute(
            select(KnowledgeItem).where(
                KnowledgeItem.org_id == person.org_id,
                KnowledgeItem.owner_candidate_person_id == person.id,
                KnowledgeItem.owner_person_id.is_(None),
            )
        )
        .scalars()
        .all()
    )
    return CoverageDisclosure(
        utterance_count=len(utterances),
        low_confidence_or_gap_count=len(low),
        excluded_item_count=len(excluded),
    )


@router.get("", response_model=list[PersonListItem])
async def list_people(
    org_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> list[PersonListItem]:
    people = db.execute(select(Person).where(Person.org_id == org_id)).scalars().all()
    now = datetime.now(UTC)
    rows: list[PersonListItem] = []
    for person in people:
        commitments = (
            db.execute(
                select(KnowledgeItem).where(
                    KnowledgeItem.org_id == org_id,
                    KnowledgeItem.owner_person_id == person.id,
                    KnowledgeItem.type == KnowledgeType.COMMITMENT,
                    KnowledgeItem.confidence.in_(COUNTED_CONFIDENCES),
                )
            )
            .scalars()
            .all()
        )
        open_items = [c for c in commitments if c.lifecycle_state != LifecycleState.RESOLVED]
        overdue = [c for c in open_items if c.due_at is not None and c.due_at < now]
        rows.append(
            PersonListItem(
                id=person.id,
                display_name=person.display_name,
                email=person.email,
                user_id=person.user_id,
                open_commitments=len(open_items),
                overdue_commitments=len(overdue),
            )
        )
    rows.sort(key=lambda row: row.display_name.lower())
    return rows


@router.get("/{person_id}", response_model=PersonDetail)
async def get_person_detail(
    org_id: str,
    person_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> PersonDetail:
    person = _get_person_or_404(db, org_id, person_id)
    items = (
        db.execute(
            select(KnowledgeItem).where(
                KnowledgeItem.org_id == org_id,
                KnowledgeItem.owner_person_id == person.id,
                KnowledgeItem.confidence.in_(COUNTED_CONFIDENCES),
            )
        )
        .scalars()
        .all()
    )
    commitments = [item for item in items if item.type == KnowledgeType.COMMITMENT]
    decisions = [item for item in items if item.type == KnowledgeType.DECISION]
    commitments.sort(key=lambda item: item.created_at, reverse=True)
    decisions.sort(key=lambda item: item.created_at, reverse=True)
    return PersonDetail(
        id=person.id,
        display_name=person.display_name,
        email=person.email,
        user_id=person.user_id,
        commitments=[_item_out(db, item) for item in commitments],
        decisions_authored=[_item_out(db, item) for item in decisions],
        coverage=_coverage_for_person(db, person),
    )


@router.get("/{person_id}/analysis/latest", response_model=PersonAnalysisOut)
async def get_latest_person_analysis(
    org_id: str,
    person_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> PersonAnalysisOut:
    _get_person_or_404(db, org_id, person_id)
    run = db.execute(
        select(PersonAnalysisRun)
        .where(
            PersonAnalysisRun.org_id == org_id,
            PersonAnalysisRun.person_id == person_id,
            PersonAnalysisRun.state == LongitudinalState.DONE,
        )
        .order_by(PersonAnalysisRun.period_end.desc())
        .limit(1)
    ).scalar_one_or_none()
    commitments = db.execute(
        select(KnowledgeItem).where(
            KnowledgeItem.org_id == org_id,
            KnowledgeItem.owner_person_id == person_id,
            KnowledgeItem.type == KnowledgeType.COMMITMENT,
            KnowledgeItem.confidence.in_(COUNTED_CONFIDENCES),
        )
    ).scalars().all()
    timeline = sorted((_item_out(db, item) for item in commitments), key=lambda item: item.occurred_at)
    monthly: dict[str, list[KnowledgeItem]] = {}
    for item in commitments:
        meeting = _meeting_for_item(db, item)
        occurred = meeting.scheduled_start or meeting.created_at
        monthly.setdefault(occurred.strftime("%Y-%m"), []).append(item)
    trend = [
        TrendPoint(
            period=period,
            delivered=sum(item.lifecycle_state == LifecycleState.RESOLVED for item in items),
            total=len(items),
            coverage_gap=any(item.overlaps_coverage_gap for item in items),
            evidence_url=(
                f"/meetings/{items[0].capture_session_id}/report?item={items[0].id}"
                if items else None
            ),
        )
        for period, items in sorted(monthly.items())
    ]
    blocked = sum(bool(_blockers_for_item(db, item)) for item in commitments)
    funnel = FunnelOut(
        stated=len(commitments),
        open=sum(item.lifecycle_state != LifecycleState.RESOLVED for item in commitments),
        recurring=sum(item.lifecycle_state in {LifecycleState.RECURRING, LifecycleState.REOPENED} for item in commitments),
        blocked=blocked,
        delivered=sum(item.lifecycle_state == LifecycleState.RESOLVED for item in commitments),
    )
    status_distribution = {
        state.value: sum(item.lifecycle_state == state for item in commitments)
        for state in LifecycleState
    }
    decisions = db.execute(
        select(KnowledgeItem).where(
            KnowledgeItem.org_id == org_id,
            KnowledgeItem.owner_person_id == person_id,
            KnowledgeItem.type == KnowledgeType.DECISION,
            KnowledgeItem.confidence.in_(COUNTED_CONFIDENCES),
        )
    ).scalars().all()
    decision_ids = [item.id for item in decisions]
    evolution: list[LifecycleHop] = []
    if decision_ids:
        edge_rows = db.execute(
            select(KnowledgeEdge, KnowledgeItem)
            .join(KnowledgeItem, KnowledgeItem.id == KnowledgeEdge.from_item_id)
            .where(
                KnowledgeEdge.org_id == org_id,
                KnowledgeEdge.kind.in_([EdgeKind.SUPERSEDES, EdgeKind.CONTRADICTS]),
                (KnowledgeEdge.from_item_id.in_(decision_ids) | KnowledgeEdge.to_item_id.in_(decision_ids)),
            )
        ).all()
        for edge, source in edge_rows:
            meeting = _meeting_for_item(db, source)
            occurred = meeting.scheduled_start or meeting.created_at
            evolution.append(
                LifecycleHop(
                    edge_id=edge.id,
                    from_item_id=edge.from_item_id,
                    to_item_id=edge.to_item_id,
                    kind=edge.kind.value,
                    rationale=edge.rationale,
                    from_statement=source.statement,
                    from_meeting_title=meeting.title or "Untitled meeting",
                    from_occurred_at=occurred.isoformat(),
                    evidence_url=(
                        f"/meetings/{source.capture_session_id}/report?item={source.id}"
                    ),
                )
            )
        evolution.sort(key=lambda hop: hop.from_occurred_at)
    if run is None:
        return PersonAnalysisOut(
            available=False,
            commitment_timeline=timeline,
            follow_through_trend=trend,
            decision_evolution=evolution,
            commitment_funnel=funnel,
            status_distribution=status_distribution,
        )
    findings = db.execute(
        select(LongitudinalFinding).where(
            LongitudinalFinding.analysis_run_id == run.id,
            LongitudinalFinding.audit_status.in_(
                [FindingAuditStatus.SUPPORTED, FindingAuditStatus.PARTIALLY_SUPPORTED]
            ),
        )
    ).scalars().all()
    finding_rows: list[LongitudinalFindingOut] = []
    heat: list[list[PersonKnowledgeOut]] = []
    for finding in findings:
        evidence_items = [
            item for item_id in finding.evidence_item_ids
            if (item := db.get(KnowledgeItem, item_id)) is not None and item.org_id == org_id
        ]
        rendered = [_item_out(db, item) for item in evidence_items]
        finding_rows.append(
            LongitudinalFindingOut(
                id=finding.id,
                kind=finding.kind.value,
                statement=finding.statement,
                confidence=finding.confidence.value,
                audit_status=finding.audit_status.value,
                sample_size=finding.sample_size,
                evidence=rendered,
            )
        )
        if finding.kind.value == "repetition":
            heat.append(rendered)
    return PersonAnalysisOut(
        available=True,
        run_id=run.id,
        state=run.state.value,
        summary=run.summary,
        coverage=run.coverage_disclosure,
        findings=finding_rows,
        commitment_timeline=timeline,
        follow_through_trend=trend,
        recurrence_heat_strip=heat,
        decision_evolution=evolution,
        commitment_funnel=funnel,
        status_distribution=status_distribution,
    )


@router.get("/{person_id}/items/{item_id}/lifecycle", response_model=list[LifecycleHop])
async def get_lifecycle_chain(
    org_id: str,
    person_id: str,
    item_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> list[LifecycleHop]:
    _get_person_or_404(db, org_id, person_id)
    item = db.get(KnowledgeItem, item_id)
    if item is None or item.org_id != org_id:
        raise HTTPException(404, "knowledge item not found")
    visited_items = {item.id}
    frontier = {item.id}
    hops: list[LifecycleHop] = []
    while frontier and len(visited_items) <= 50:
        edge_rows = db.execute(
            select(KnowledgeEdge, KnowledgeItem)
            .join(KnowledgeItem, KnowledgeItem.id == KnowledgeEdge.from_item_id)
            .where(
                KnowledgeEdge.org_id == org_id,
                KnowledgeEdge.to_item_id.in_(frontier),
                KnowledgeEdge.kind != EdgeKind.CONTRADICTS,
            )
        ).all()
        frontier = set()
        for edge, source in edge_rows:
            meeting = _meeting_for_item(db, source)
            occurred_at = meeting.scheduled_start or meeting.created_at
            hops.append(
                LifecycleHop(
                    edge_id=edge.id,
                    from_item_id=edge.from_item_id,
                    to_item_id=edge.to_item_id,
                    kind=edge.kind.value,
                    rationale=edge.rationale,
                    from_statement=source.statement,
                    from_meeting_title=meeting.title or "Untitled meeting",
                    from_occurred_at=occurred_at.isoformat(),
                    evidence_url=(
                        f"/meetings/{source.capture_session_id}/report?item={source.id}"
                    ),
                )
            )
            if source.id not in visited_items:
                visited_items.add(source.id)
                frontier.add(source.id)
    hops.sort(key=lambda hop: hop.from_occurred_at)
    return hops


@router.get("/interactions/map", response_model=InteractionMap)
async def get_interaction_map(
    org_id: str,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> InteractionMap:
    people = db.execute(select(Person).where(Person.org_id == org_id)).scalars().all()
    people_by_id = {person.id: person for person in people}
    edge_weights: dict[tuple[str, str, str], tuple[int, str]] = {}

    delegated = db.execute(
        select(KnowledgeItem, Utterance)
        .join(Utterance, Utterance.id == KnowledgeItem.owner_utterance_id)
        .where(
            KnowledgeItem.org_id == org_id,
            KnowledgeItem.owner_person_id.isnot(None),
            Utterance.person_id.isnot(None),
            KnowledgeItem.owner_person_id != Utterance.person_id,
            KnowledgeItem.confidence.in_(COUNTED_CONFIDENCES),
        )
    ).all()
    for item, utterance in delegated:
        key = (utterance.person_id, item.owner_person_id, "delegates_to")
        count, evidence_url = edge_weights.get(
            key, (0, f"/meetings/{item.capture_session_id}/report?item={item.id}")
        )
        edge_weights[key] = (count + 1, evidence_url)

    blockers = (
        db.execute(
            select(KnowledgeEdge).where(
                KnowledgeEdge.org_id == org_id, KnowledgeEdge.kind == EdgeKind.BLOCKS
            )
        )
        .scalars()
        .all()
    )
    for edge in blockers:
        blocker = db.get(KnowledgeItem, edge.from_item_id)
        target = db.get(KnowledgeItem, edge.to_item_id)
        if blocker and blocker.owner_person_id and target and target.owner_person_id:
            key = (blocker.owner_person_id, target.owner_person_id, "blocks")
            count, evidence_url = edge_weights.get(
                key,
                (0, f"/meetings/{blocker.capture_session_id}/report?item={blocker.id}"),
            )
            edge_weights[key] = (count + 1, evidence_url)

    nodes = [
        InteractionNode(person_id=person.id, display_name=person.display_name) for person in people
    ]
    edges = [
        InteractionEdge(
            from_person_id=src,
            to_person_id=dst,
            kind=kind,
            weight=value[0],
            evidence_url=value[1],
        )
        for (src, dst, kind), value in edge_weights.items()
        if src in people_by_id and dst in people_by_id and src != dst
    ]
    return InteractionMap(nodes=nodes, edges=edges)
