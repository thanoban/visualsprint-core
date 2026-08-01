"""Context Intelligence — extracts candidate knowledge items from raw evidence.

Reads Utterance + Keyframe rows for a capture_session and asks the LLM to
propose candidate decisions/commitments/requirements/blockers/questions/facts.
Candidates are persisted as `KnowledgeItem` rows with `confidence=AMBIGUOUS`
and an empty `confidence_rationale` — that empty string is the "not yet
verified" marker the verify stage uses to pick up work idempotently.

The model's `rationale` for each candidate is logged for observability only —
it is never written to a column the verification stage reads. That is what
keeps rule 3 (verification never sees Context's reasoning) structurally true
rather than a matter of discipline: the field simply doesn't reach storage
the verification query path touches.
"""

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
    Utterance,
)
from app.interfaces.llm import LlmClient

log = structlog.get_logger()

SYSTEM_PROMPT = """You are Context Intelligence for a meeting-intelligence platform.
Read the utterances (speech) and keyframes (screen) from one meeting and extract
CANDIDATE knowledge items: decisions, commitments, requirements, blockers, questions,
and standalone facts worth remembering. For every candidate, cite the exact
utterance_ids and/or keyframe_ids that support it, and explain your reasoning in
`rationale`. Only propose items with at least one supporting utterance_id or
keyframe_id drawn from the provided ids — never invent ids. Be conservative: prefer
fewer, well-evidenced candidates over speculative ones. Downstream verification will
independently check every claim against the cited evidence, so it is fine — expected
— to surface uncertain candidates; do not silently drop them."""


class CandidateKnowledgeItem(BaseModel):
    type: KnowledgeType
    statement: str
    supporting_utterance_ids: list[str] = []
    supporting_keyframe_ids: list[str] = []
    owner_hint: str | None = None
    due_hint: str | None = None
    rationale: str


class CandidateExtractionResult(BaseModel):
    items: list[CandidateKnowledgeItem] = []


def _format_utterance(u: Utterance) -> str:
    return f"[utterance:{u.id}] t={u.start_s:.1f}-{u.end_s:.1f}s speaker={u.person_id or 'unknown'}: {u.text}"


def _format_keyframe(k: Keyframe) -> str:
    parts = [f"[keyframe:{k.id}] t={k.valid_from_s:.1f}-{k.valid_to_s:.1f}s"]
    if k.ocr_text:
        parts.append(f"ocr='{k.ocr_text}'")
    if k.vlm_caption:
        parts.append(f"caption='{k.vlm_caption}'")
    return " ".join(parts)


def _build_user_content(utterances: list[Utterance], keyframes: list[Keyframe]) -> str:
    lines = ["UTTERANCES:"]
    lines.extend(_format_utterance(u) for u in utterances)
    lines.append("")
    lines.append("KEYFRAMES:")
    lines.extend(_format_keyframe(k) for k in keyframes)
    return "\n".join(lines)


def _resolve_owner(db: Session, org_id: str, owner_hint: str | None) -> str | None:
    if not owner_hint:
        return None
    from app.db.models import Person

    candidates = db.query(Person).filter(Person.org_id == org_id).all()
    hint_lower = owner_hint.strip().lower()
    for person in candidates:
        if person.display_name.strip().lower() == hint_lower:
            return person.id
        if any(str(alias).strip().lower() == hint_lower for alias in person.aliases):
            return person.id
    return None


def _parse_due(due_hint: str | None):
    if not due_hint:
        return None
    from datetime import UTC, datetime

    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S"):
        try:
            dt = datetime.strptime(due_hint, fmt)
            return dt.replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


async def run_context_intelligence(
    db: Session,
    capture_session_id: str,
    llm: LlmClient,
    model: str | None = None,
) -> list[str]:
    """Extract candidates for one session; returns created KnowledgeItem ids."""
    session = db.get(CaptureSession, capture_session_id)
    if session is None:
        raise ValueError(f"capture_session {capture_session_id} not found")

    utterances = (
        db.query(Utterance)
        .filter(Utterance.capture_session_id == capture_session_id)
        .order_by(Utterance.start_s)
        .all()
    )
    keyframes = (
        db.query(Keyframe)
        .filter(Keyframe.capture_session_id == capture_session_id)
        .order_by(Keyframe.valid_from_s)
        .all()
    )
    if not utterances and not keyframes:
        return []

    known_utterance_ids = {u.id for u in utterances}
    known_keyframe_ids = {k.id for k in keyframes}

    from app.config import get_settings

    model = model or get_settings().model_extract
    result, usage = await llm.complete_structured(
        model=model,
        system=SYSTEM_PROMPT,
        user_content=_build_user_content(utterances, keyframes),
        schema=CandidateExtractionResult,
    )
    log.info(
        "context.extracted",
        session=capture_session_id,
        candidates=len(result.items),
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
    )

    created_ids: list[str] = []
    for candidate in result.items:
        utterance_ids = [
            uid for uid in candidate.supporting_utterance_ids if uid in known_utterance_ids
        ]
        keyframe_ids = [
            kid for kid in candidate.supporting_keyframe_ids if kid in known_keyframe_ids
        ]
        if not utterance_ids and not keyframe_ids:
            log.warning("context.candidate_dropped_no_evidence", statement=candidate.statement)
            continue

        # candidate.rationale is intentionally NOT stored — logged for
        # observability only, never persisted where verification can read it.
        log.info(
            "context.candidate_rationale",
            statement=candidate.statement,
            rationale=candidate.rationale,
        )

        item = KnowledgeItem(
            org_id=session.org_id,
            capture_session_id=capture_session_id,
            type=candidate.type,
            statement=candidate.statement,
            owner_person_id=_resolve_owner(db, session.org_id, candidate.owner_hint),
            due_at=_parse_due(candidate.due_hint),
            confidence=Confidence.AMBIGUOUS,
            confidence_rationale="",
        )
        db.add(item)
        db.flush()

        for uid in utterance_ids:
            db.add(
                KnowledgeEvidence(
                    org_id=session.org_id,
                    knowledge_item_id=item.id,
                    utterance_id=uid,
                    role="primary",
                )
            )
        for kid in keyframe_ids:
            db.add(
                KnowledgeEvidence(
                    org_id=session.org_id,
                    knowledge_item_id=item.id,
                    keyframe_id=kid,
                    role="primary",
                )
            )
        created_ids.append(item.id)

    return created_ids
