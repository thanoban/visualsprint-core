"""Evidence-grounded meeting report — GET /api/v1/meetings/{capture_session_id}/report.

Reads ONLY KnowledgeItem + KnowledgeEvidence + Keyframe + Utterance (for citation
metadata: speaker/timestamp) + CoverageInterval. No LLM call happens on this path —
every field is a direct DB read of already-verified knowledge_item rows, grouped by
type, with inline screenshot evidence (CLAUDE.md: reports embed thumbnails, not just
links) and a coverage-gap banner (CLAUDE.md: capture gaps are data, not silence).

Note on evidence quotes: this is a human-facing read endpoint downstream of
verification, not the Report Intelligence agent's input schema
(backend/app/agents/report.py `ReportInput`, which structurally cannot hold
transcript text per CLAUDE.md rule 2 — that rule concerns what reaches the LLM).
A short truncated utterance snippet is included here purely for the browser to
display next to the speaker/timestamp citation, matching frontend/lib/types.ts
`EvidenceRef.quote` and the report page's rendering.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters.blobstore_s3 import get_blobstore
from app.db.base import get_db
from app.db.models import (
    CaptureSession,
    CoverageInterval,
    CoverageStatus,
    Keyframe,
    KnowledgeEvidence,
    KnowledgeItem,
    KnowledgeType,
    Meeting,
    Person,
    Utterance,
)

router = APIRouter(prefix="/api/v1/meetings", tags=["report"])

QUOTE_MAX_CHARS = 280

TYPE_TO_FIELD = {
    KnowledgeType.DECISION: "decisions",
    KnowledgeType.COMMITMENT: "commitments",
    KnowledgeType.REQUIREMENT: "requirements",
    KnowledgeType.BLOCKER: "blockers",
    KnowledgeType.QUESTION: "questions",
    KnowledgeType.FACT: "facts",
}


class EvidenceRef(BaseModel):
    id: str
    speaker: str
    timestamp_s: float
    quote: str | None = None
    quote_lang_tags: list[str] = []  # e.g. ["si","en"] — quote is verbatim, never translated
    keyframe_thumbnail_url: str | None = None
    keyframe_caption: str | None = None


class ParticipantEngagement(BaseModel):
    person_id: str | None = None
    display_name: str
    talk_time_s: float
    utterance_count: int
    talk_time_pct: float  # of total attributed talk time in this session


class EngagementSummary(BaseModel):
    total_talk_time_s: float
    participants: list[ParticipantEngagement] = []


class ReportKnowledgeItem(BaseModel):
    id: str
    type: str
    statement: str
    owner: str | None = None
    due: str | None = None
    confidence: str
    lifecycle_state: str
    rationale: str | None = None
    coverage_gap: bool
    evidence: list[EvidenceRef] = []


class CoverageGap(BaseModel):
    id: str
    modality: str
    status: str
    reason: str
    start_s: float
    end_s: float


class MeetingReport(BaseModel):
    meeting_id: str
    capture_session_id: str
    title: str
    occurred_at: str
    coverage_gaps: list[CoverageGap] = []
    engagement: EngagementSummary = EngagementSummary(total_talk_time_s=0.0, participants=[])
    decisions: list[ReportKnowledgeItem] = []
    commitments: list[ReportKnowledgeItem] = []
    requirements: list[ReportKnowledgeItem] = []
    blockers: list[ReportKnowledgeItem] = []
    questions: list[ReportKnowledgeItem] = []
    facts: list[ReportKnowledgeItem] = []


def _truncate(text: str, limit: int = QUOTE_MAX_CHARS) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _build_engagement(db: Session, capture_session_id: str) -> EngagementSummary:
    """Talk-time-per-participant, matching the "who talked how much" report
    every competitor ships (Zoom AI Companion, Fireflies, Otter). Pure
    aggregation over Utterance rows already written by the transcribe stage
    -- no new capture, no LLM call, no extra cost. Attribution confidence is
    NOT filtered here: an org with only mixed audio (Mode D/Meet, no
    diarization wired yet) sees every row bucketed under "Unknown speaker"
    rather than the endpoint pretending to know who spoke -- same "honestly
    weaker, never silently degraded" rule the rest of the product follows."""
    utterances = (
        db.query(Utterance)
        .filter(Utterance.capture_session_id == capture_session_id, Utterance.text != "")
        .all()
    )
    if not utterances:
        return EngagementSummary(total_talk_time_s=0.0, participants=[])

    by_speaker: dict[str | None, list[Utterance]] = {}
    for utt in utterances:
        by_speaker.setdefault(utt.person_id, []).append(utt)

    total_s = sum(max(0.0, u.end_s - u.start_s) for u in utterances)

    participants: list[ParticipantEngagement] = []
    for person_id, utts in by_speaker.items():
        talk_time_s = sum(max(0.0, u.end_s - u.start_s) for u in utts)
        display_name = "Unknown speaker"
        if person_id:
            person = db.get(Person, person_id)
            display_name = person.display_name if person else "Unknown speaker"
        participants.append(
            ParticipantEngagement(
                person_id=person_id,
                display_name=display_name,
                talk_time_s=talk_time_s,
                utterance_count=len(utts),
                talk_time_pct=(talk_time_s / total_s * 100.0) if total_s > 0 else 0.0,
            )
        )
    participants.sort(key=lambda p: p.talk_time_s, reverse=True)
    return EngagementSummary(total_talk_time_s=total_s, participants=participants)


async def _build_evidence(db: Session, blob, row: KnowledgeEvidence) -> EvidenceRef | None:
    if row.utterance_id:
        utt = db.get(Utterance, row.utterance_id)
        if utt is None:
            return None
        speaker = "Unknown speaker"
        if utt.person_id:
            person = db.get(Person, utt.person_id)
            if person is not None:
                speaker = person.display_name
        return EvidenceRef(
            id=row.id,
            speaker=speaker,
            timestamp_s=utt.start_s,
            quote=_truncate(utt.text) if utt.text else None,
            quote_lang_tags=list(utt.lang_tags or []),
        )
    if row.keyframe_id:
        kf = db.get(Keyframe, row.keyframe_id)
        if kf is None:
            return None
        thumb = await blob.presigned_url(kf.image_uri) if kf.image_uri else None
        caption = kf.vlm_caption or kf.ocr_text or None
        return EvidenceRef(
            id=row.id,
            speaker="Screen capture",
            timestamp_s=kf.valid_from_s,
            keyframe_thumbnail_url=thumb,
            keyframe_caption=_truncate(caption) if caption else None,
        )
    return None


@router.get("/{capture_session_id}/report", response_model=MeetingReport)
async def get_meeting_report(
    capture_session_id: str, db: Session = Depends(get_db)
) -> MeetingReport:
    session = db.get(CaptureSession, capture_session_id)
    if session is None:
        raise HTTPException(404, "capture session not found")
    meeting = db.get(Meeting, session.meeting_id)
    if meeting is None:
        raise HTTPException(404, "meeting not found")

    blob = get_blobstore()
    groups: dict[str, list[ReportKnowledgeItem]] = {field: [] for field in TYPE_TO_FIELD.values()}

    items = (
        db.query(KnowledgeItem)
        .filter(KnowledgeItem.capture_session_id == capture_session_id)
        .order_by(KnowledgeItem.created_at)
        .all()
    )
    for item in items:
        owner_name = None
        if item.owner_person_id:
            person = db.get(Person, item.owner_person_id)
            owner_name = person.display_name if person else None

        evidence_rows = (
            db.query(KnowledgeEvidence).filter(KnowledgeEvidence.knowledge_item_id == item.id).all()
        )
        evidence: list[EvidenceRef] = []
        for row in evidence_rows:
            ref = await _build_evidence(db, blob, row)
            if ref is not None:
                evidence.append(ref)

        report_item = ReportKnowledgeItem(
            id=item.id,
            type=item.type.value,
            statement=item.statement,
            owner=owner_name,
            due=item.due_at.isoformat() if item.due_at else None,
            confidence=item.confidence.value,
            lifecycle_state=item.lifecycle_state.value,
            rationale=item.confidence_rationale or None,
            coverage_gap=item.overlaps_coverage_gap,
            evidence=evidence,
        )
        groups[TYPE_TO_FIELD[item.type]].append(report_item)

    gaps = (
        db.query(CoverageInterval)
        .filter(
            CoverageInterval.capture_session_id == capture_session_id,
            CoverageInterval.status != CoverageStatus.OK,
        )
        .order_by(CoverageInterval.start_s)
        .all()
    )
    coverage_gaps = [
        CoverageGap(
            id=gap.id,
            modality=gap.modality,
            status=gap.status.value,
            reason=gap.reason or "",
            start_s=gap.start_s,
            end_s=gap.end_s,
        )
        for gap in gaps
    ]

    occurred_at = (meeting.scheduled_start or meeting.created_at).isoformat()
    engagement = _build_engagement(db, capture_session_id)

    return MeetingReport(
        meeting_id=meeting.id,
        capture_session_id=capture_session_id,
        title=meeting.title or "Untitled meeting",
        occurred_at=occurred_at,
        coverage_gaps=coverage_gaps,
        engagement=engagement,
        **groups,
    )
