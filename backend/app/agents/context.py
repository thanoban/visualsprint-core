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

import unicodedata
from datetime import datetime

import structlog
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.models import (
    CaptureSession,
    Confidence,
    CoverageInterval,
    CoverageStatus,
    Keyframe,
    KnowledgeEvidence,
    KnowledgeItem,
    KnowledgeType,
    Utterance,
)
from app.interfaces.llm import LlmClient

log = structlog.get_logger()
MIN_OWNER_ATTRIBUTION_CONFIDENCE = 0.75
PROMPT_VERSION = "context-v1"

SYSTEM_PROMPT = """You are Context Intelligence for a meeting-intelligence platform.
Read the utterances (speech) and keyframes (screen) from one meeting and extract
CANDIDATE knowledge items: decisions, commitments, requirements, blockers, questions,
and standalone facts worth remembering. For every candidate, cite the exact
utterance_ids and/or keyframe_ids that support it, and explain your reasoning in
`rationale`. Only propose items with at least one supporting utterance_id or
keyframe_id drawn from the provided ids — never invent ids. Be conservative: prefer
fewer, well-evidenced candidates over speculative ones. Downstream verification will
independently check every claim against the cited evidence, so it is fine — expected
— to surface uncertain candidates; do not silently drop them.

LANGUAGE: the meeting may mix Sinhala, Tamil, and English, including within a single
sentence. Write every `statement` in clear English regardless of the utterances'
original language(s) — you have full context here to translate accurately, which a
later isolated translation pass would not. Do NOT translate or paraphrase the
evidence itself; you are only choosing the language of your own summary sentence.
The original-language utterance text remains the evidence of record downstream and
is never altered.

OWNERSHIP: For commitments, set owner_hint only when a named person is explicitly
responsible. Set owner_is_speaker=true and owner_utterance_id when the speaker commits
themself ("I'll...", "I will...", "මම...", "நான்...", including common romanized
forms). Do not default ownership to the speaker for passive statements like "the
gateway needs fixing". Use due_hint for explicit or relative dates such as "tomorrow"
or "next week"; the meeting date is supplied in the prompt. Set abstained=true and
return no items when there is not enough evidence; abstention is correct behaviour."""


class CandidateKnowledgeItem(BaseModel):
    type: KnowledgeType
    statement: str  # always English — see SYSTEM_PROMPT's LANGUAGE section
    supporting_utterance_ids: list[str] = []
    supporting_keyframe_ids: list[str] = []
    owner_hint: str | None = None
    owner_is_speaker: bool = False
    owner_utterance_id: str | None = None
    due_hint: str | None = None
    rationale: str


class CandidateExtractionResult(BaseModel):
    items: list[CandidateKnowledgeItem] = []
    abstained: bool = False


def _format_utterance(u: Utterance) -> str:
    return f"[utterance:{u.id}] t={u.start_s:.1f}-{u.end_s:.1f}s speaker={u.person_id or 'unknown'}: {u.text}"


def _format_keyframe(k: Keyframe) -> str:
    parts = [f"[keyframe:{k.id}] t={k.valid_from_s:.1f}-{k.valid_to_s:.1f}s"]
    if k.ocr_text:
        parts.append(f"ocr='{k.ocr_text}'")
    if k.vlm_caption:
        parts.append(f"caption='{k.vlm_caption}'")
    return " ".join(parts)


def _build_user_content(
    utterances: list[Utterance], keyframes: list[Keyframe], *, meeting_date: str
) -> str:
    lines = [f"MEETING_DATE: {meeting_date}", "", "UTTERANCES:"]
    lines.extend(_format_utterance(u) for u in utterances)
    lines.append("")
    lines.append("KEYFRAMES:")
    lines.extend(_format_keyframe(k) for k in keyframes)
    return "\n".join(lines)


_HONORIFICS = frozenset(
    ["mr", "mrs", "ms", "dr", "prof", "sir", "rev", "aiya", "akka", "nona", "mahattaya", "මහත්මයා", "මිය", "මහත්තයා", "ස්වාමිය", "anna", "amma", "appa"]
)


def _normalize_name(s: str) -> str:
    """NFKC-normalise + casefold + strip honorifics for multilingual name matching."""
    normed = unicodedata.normalize("NFKC", s).casefold().strip()
    tokens = [t.strip(".,") for t in normed.split()]
    filtered = [t for t in tokens if t and t not in _HONORIFICS]
    return " ".join(filtered) if filtered else normed


def _resolve_owner_hint(db: Session, org_id: str, owner_hint: str | None) -> str | None:
    if not owner_hint:
        return None
    from app.db.models import Person

    candidates = db.query(Person).filter(Person.org_id == org_id).all()
    hint_normed = _normalize_name(owner_hint)
    matches: list[str] = []
    for person in candidates:
        if _normalize_name(person.display_name) == hint_normed:
            matches.append(person.id)
            continue
        if any(_normalize_name(str(alias)) == hint_normed for alias in person.aliases):
            matches.append(person.id)
    return matches[0] if len(set(matches)) == 1 else None


def _has_self_reference(text: str) -> bool:
    lowered = f" {text.lower()} "
    tokens = (
        " i'll ",
        " i’ll ",
        " i will ",
        " im going to ",
        " i'm going to ",
        " i can ",
        " i’ll take ",
        " i'll take ",
        " mage ",
        " mama ",
        " mam ",
        " මම",
        " நான்",
        " naan ",
        " nan ",
    )
    return any(token in lowered for token in tokens)


def _resolve_owner_from_speaker(
    utterance: Utterance | None,
) -> tuple[str | None, str | None, float | None]:
    if utterance is None or utterance.person_id is None:
        return None, None, None
    confidence = utterance.attribution_confidence
    if confidence >= MIN_OWNER_ATTRIBUTION_CONFIDENCE:
        return utterance.person_id, None, confidence
    return None, utterance.person_id, confidence


def _overlaps_any_gap(start_s: float, end_s: float, gaps: list[CoverageInterval]) -> bool:
    return any(start_s < g.end_s and end_s > g.start_s for g in gaps)


def _parse_due(due_hint: str | None, *, meeting_dt: datetime | None) -> datetime | None:
    if not due_hint:
        return None
    from datetime import UTC, datetime, timedelta

    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S"):
        try:
            dt = datetime.strptime(due_hint, fmt)
            return dt.replace(tzinfo=UTC)
        except ValueError:
            continue
    base = meeting_dt.astimezone(UTC) if meeting_dt else datetime.now(UTC)
    lowered = due_hint.strip().lower()
    if lowered in {"tomorrow", "හෙට", "நாளை", "nalai"}:
        return (base + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    if lowered in {
        "next week",
        "ලබන සතියේ",
        "adutha varam",
        "அடுத்த வாரம்",
        "next monday",
    }:
        days_until_next_monday = (7 - base.weekday()) or 7
        return (base + timedelta(days=days_until_next_monday)).replace(
            hour=9, minute=0, second=0, microsecond=0
        )
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
    utterance_by_id = {u.id: u for u in utterances}
    meeting_dt = (
        session.meeting.scheduled_start if session.meeting else None
    ) or session.created_at
    meeting_date = meeting_dt.date().isoformat()
    coverage_gaps = (
        db.query(CoverageInterval)
        .filter(
            CoverageInterval.capture_session_id == capture_session_id,
            CoverageInterval.status != CoverageStatus.OK,
        )
        .all()
    )

    from app.config import get_settings

    model = model or get_settings().model_extract
    result, usage = await llm.complete_structured(
        model=model,
        system=SYSTEM_PROMPT,
        user_content=_build_user_content(utterances, keyframes, meeting_date=meeting_date),
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

        # CLAUDE.md rule 6: capture gaps must visibly flag overlapping items.
        # Only utterance evidence is checked -- this pass only produces
        # audio-modality gaps (app/asr/coverage.py); a keyframe can't overlap
        # an audio gap in any meaningful sense.
        overlaps_gap = any(
            _overlaps_any_gap(
                utterance_by_id[uid].start_s, utterance_by_id[uid].end_s, coverage_gaps
            )
            for uid in utterance_ids
        )
        owner_person_id = _resolve_owner_hint(db, session.org_id, candidate.owner_hint)
        owner_candidate_person_id = None
        owner_source = "spoken_name" if owner_person_id else None
        owner_utterance_id = None
        owner_confidence = 1.0 if owner_person_id else None

        explicit_owner_utterance = (
            utterance_by_id.get(candidate.owner_utterance_id)
            if candidate.owner_utterance_id
            else None
        )
        self_reference_utterance = explicit_owner_utterance
        if self_reference_utterance is None:
            self_reference_utterance = next(
                (
                    utterance_by_id[uid]
                    for uid in utterance_ids
                    if _has_self_reference(utterance_by_id[uid].text)
                ),
                None,
            )
        if owner_person_id is None and (candidate.owner_is_speaker or self_reference_utterance):
            resolved_owner, candidate_owner, confidence = _resolve_owner_from_speaker(
                self_reference_utterance
            )
            owner_person_id = resolved_owner
            owner_candidate_person_id = candidate_owner
            owner_utterance_id = self_reference_utterance.id if self_reference_utterance else None
            owner_source = "speaker_derived" if resolved_owner else "speaker_candidate"
            owner_confidence = confidence

        item = KnowledgeItem(
            org_id=session.org_id,
            capture_session_id=capture_session_id,
            type=candidate.type,
            statement=candidate.statement,
            owner_person_id=owner_person_id,
            owner_candidate_person_id=owner_candidate_person_id,
            owner_utterance_id=owner_utterance_id,
            owner_source=owner_source,
            owner_attribution_confidence=owner_confidence,
            due_at=_parse_due(candidate.due_hint, meeting_dt=meeting_dt),
            confidence=Confidence.AMBIGUOUS,
            confidence_rationale="",
            overlaps_coverage_gap=overlaps_gap,
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
