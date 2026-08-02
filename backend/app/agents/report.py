"""Report Intelligence — renders the final report from verified items only.

Structural guarantee (rule 2): `ReportInput` (and everything it's built from)
cannot hold raw transcript text. `ReportEvidence.utterance` is a
`UtteranceRef` with only id/timing/speaker fields — no `content`/`text`
attribute exists on that model, so there is no field a transcript string
could even be assigned to. The DB query that builds it
(`_load_utterance_refs`) selects only `Utterance.id, .start_s, .end_s,
.person_id` columns — `Utterance.text` is never fetched, so the bug class
"someone forgot to strip the text before handing it to the LLM" cannot occur
either. Keyframe evidence carries `image_uri` inline (rule 5) plus
`ocr_text`/`vlm_caption`, which are screen-derived, not spoken transcript.
"""

from datetime import datetime

import structlog
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.models import (
    CaptureSession,
    Confidence,
    Keyframe,
    KnowledgeEvidence,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Utterance,
)
from app.interfaces.llm import LlmClient

log = structlog.get_logger()

SYSTEM_PROMPT = """You are Report Intelligence for a meeting-intelligence platform.
You receive only verified knowledge items and their evidence references — never raw
transcript. Write a concise structured meeting report: an executive summary, and per
item a one-line rendering of the statement with its owner/due date/lifecycle state if
present. Do not speculate beyond the given statements.

LANGUAGE: item statements are already normalized to English by Context Intelligence
regardless of the meeting's spoken language(s) — write your executive summary and
all report prose in English as well, for a single consistent reading language."""


class UtteranceRef(BaseModel):
    """Utterance evidence pointer only — deliberately has no text/content field."""

    utterance_id: str
    start_s: float
    end_s: float
    speaker_person_id: str | None = None


class KeyframeRef(BaseModel):
    """Keyframe evidence with inline image reference (rule 5)."""

    keyframe_id: str
    start_s: float
    end_s: float
    image_uri: str
    ocr_text: str = ""
    vlm_caption: str = ""


class ReportEvidence(BaseModel):
    utterance: UtteranceRef | None = None
    keyframe: KeyframeRef | None = None


class ReportKnowledgeItem(BaseModel):
    id: str
    type: KnowledgeType
    statement: str
    owner_person_id: str | None = None
    due_at: datetime | None = None
    lifecycle_state: LifecycleState
    confidence: Confidence
    confidence_rationale: str
    evidence: list[ReportEvidence] = []


class ReportInput(BaseModel):
    """No field on this model, or any model it references, can hold a raw
    transcript string. `statement` is Context Intelligence's distilled claim,
    not Utterance.text."""

    capture_session_id: str
    org_id: str
    items: list[ReportKnowledgeItem]


class ReportSection(BaseModel):
    item_id: str
    rendered_line: str


class GeneratedReport(BaseModel):
    title: str
    executive_summary: str
    sections: list[ReportSection]


def _load_utterance_ref(db: Session, utterance_id: str) -> UtteranceRef | None:
    row = (
        db.query(Utterance.id, Utterance.start_s, Utterance.end_s, Utterance.person_id)
        .filter(Utterance.id == utterance_id)
        .one_or_none()
    )
    if row is None:
        return None
    return UtteranceRef(
        utterance_id=row.id, start_s=row.start_s, end_s=row.end_s, speaker_person_id=row.person_id
    )


def _load_keyframe_ref(db: Session, keyframe_id: str) -> KeyframeRef | None:
    row = db.get(Keyframe, keyframe_id)
    if row is None:
        return None
    return KeyframeRef(
        keyframe_id=row.id,
        start_s=row.valid_from_s,
        end_s=row.valid_to_s,
        image_uri=row.image_uri,
        ocr_text=row.ocr_text,
        vlm_caption=row.vlm_caption,
    )


def build_report_input(db: Session, capture_session_id: str) -> ReportInput:
    session = db.get(CaptureSession, capture_session_id)
    if session is None:
        raise ValueError(f"capture_session {capture_session_id} not found")

    items = (
        db.query(KnowledgeItem)
        .filter(
            KnowledgeItem.capture_session_id == capture_session_id,
            KnowledgeItem.confidence.in_([Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED]),
        )
        .all()
    )

    report_items: list[ReportKnowledgeItem] = []
    for item in items:
        evidence_rows = (
            db.query(KnowledgeEvidence).filter(KnowledgeEvidence.knowledge_item_id == item.id).all()
        )
        evidence: list[ReportEvidence] = []
        for row in evidence_rows:
            if row.utterance_id:
                ref = _load_utterance_ref(db, row.utterance_id)
                if ref is not None:
                    evidence.append(ReportEvidence(utterance=ref))
            if row.keyframe_id:
                kref = _load_keyframe_ref(db, row.keyframe_id)
                if kref is not None:
                    evidence.append(ReportEvidence(keyframe=kref))

        report_items.append(
            ReportKnowledgeItem(
                id=item.id,
                type=item.type,
                statement=item.statement,
                owner_person_id=item.owner_person_id,
                due_at=item.due_at,
                lifecycle_state=item.lifecycle_state,
                confidence=item.confidence,
                confidence_rationale=item.confidence_rationale,
                evidence=evidence,
            )
        )

    return ReportInput(
        capture_session_id=capture_session_id, org_id=session.org_id, items=report_items
    )


async def run_report_intelligence(
    db: Session,
    capture_session_id: str,
    llm: LlmClient,
    model: str | None = None,
    blobstore=None,
) -> tuple[ReportInput, GeneratedReport, str | None]:
    """Build ReportInput, render the report, optionally persist it to the blobstore.

    Returns (input, report, blob_uri). blob_uri is None when no blobstore is given.
    """
    report_input = build_report_input(db, capture_session_id)

    from app.config import get_settings

    model = model or get_settings().model_report
    report, usage = await llm.complete_structured(
        model=model,
        system=SYSTEM_PROMPT,
        user_content=report_input.model_dump_json(),
        schema=GeneratedReport,
    )
    log.info(
        "report.generated",
        session=capture_session_id,
        items=len(report_input.items),
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
    )

    blob_uri = None
    if blobstore is not None:
        key = f"reports/{report_input.org_id}/{capture_session_id}.json"
        blob_uri = await blobstore.put(
            key, report.model_dump_json().encode("utf-8"), "application/json"
        )

    return report_input, report, blob_uri
