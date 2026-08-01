"""Evidence Verification — challenges candidates blind.

Structural guarantee (rule 3): `CandidateForVerification` has NO rationale
field. It is built fresh from the DB — the raw claim plus its cited
utterance/keyframe rows only — never from Context Intelligence's in-process
`CandidateKnowledgeItem` (which does carry a rationale). There is no code
path here that could smuggle Context's reasoning in: this module never
imports `CandidateKnowledgeItem`, and the evidence excerpts are read straight
off `Utterance`/`Keyframe` columns.
"""

from typing import Literal

import structlog
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.models import (
    Confidence,
    Keyframe,
    KnowledgeEvidence,
    KnowledgeItem,
    KnowledgeType,
    Utterance,
)
from app.interfaces.llm import LlmClient

log = structlog.get_logger()

SYSTEM_PROMPT = """You are Evidence Verification for a meeting-intelligence platform.
You will be given ONE candidate claim and the raw evidence excerpts cited for it —
nothing else. You do NOT know why another system flagged this claim; judge it purely
on whether the cited evidence actually supports the statement. Assign confidence:
- verified: evidence clearly and directly supports the statement
- partially_supported: evidence is related but doesn't fully establish the statement
- ambiguous: evidence is inconclusive
- unsupported: evidence does not support the statement, or contradicts it
Give your own rationale for the confidence you assign."""


class EvidenceExcerpt(BaseModel):
    source: Literal["utterance", "keyframe"]
    id: str
    content: str
    start_s: float | None = None
    end_s: float | None = None


class CandidateForVerification(BaseModel):
    """No `rationale` field — see module docstring. Do not add one."""

    knowledge_item_id: str
    type: KnowledgeType
    statement: str
    evidence: list[EvidenceExcerpt]


class VerificationResult(BaseModel):
    confidence: Confidence
    rationale: str


def _load_evidence(db: Session, item: KnowledgeItem) -> list[EvidenceExcerpt]:
    rows = db.query(KnowledgeEvidence).filter(KnowledgeEvidence.knowledge_item_id == item.id).all()
    excerpts: list[EvidenceExcerpt] = []
    for row in rows:
        if row.utterance_id:
            u = db.get(Utterance, row.utterance_id)
            if u is not None:
                excerpts.append(
                    EvidenceExcerpt(
                        source="utterance",
                        id=u.id,
                        content=u.text,
                        start_s=u.start_s,
                        end_s=u.end_s,
                    )
                )
        if row.keyframe_id:
            k = db.get(Keyframe, row.keyframe_id)
            if k is not None:
                content = k.ocr_text or k.vlm_caption or ""
                excerpts.append(
                    EvidenceExcerpt(
                        source="keyframe",
                        id=k.id,
                        content=content,
                        start_s=k.valid_from_s,
                        end_s=k.valid_to_s,
                    )
                )
    return excerpts


async def run_evidence_verification(
    db: Session,
    capture_session_id: str,
    llm: LlmClient,
    model: str | None = None,
) -> list[str]:
    """Verify all not-yet-verified candidates for a session; returns processed ids.

    "Not yet verified" == confidence_rationale == "" (set by context.py and
    never touched again until this stage writes its own rationale here) —
    that makes re-running this stage after a crash idempotent: already-
    verified items are skipped.
    """
    candidates = (
        db.query(KnowledgeItem)
        .filter(
            KnowledgeItem.capture_session_id == capture_session_id,
            KnowledgeItem.confidence_rationale == "",
        )
        .all()
    )
    if not candidates:
        return []

    from app.config import get_settings

    model = model or get_settings().model_verify
    processed: list[str] = []
    for item in candidates:
        evidence = _load_evidence(db, item)
        candidate = CandidateForVerification(
            knowledge_item_id=item.id,
            type=item.type,
            statement=item.statement,
            evidence=evidence,
        )
        result, usage = await llm.complete_structured(
            model=model,
            system=SYSTEM_PROMPT,
            user_content=candidate.model_dump_json(),
            schema=VerificationResult,
        )
        log.info(
            "verification.assessed",
            item=item.id,
            confidence=result.confidence,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
        )
        item.confidence = result.confidence
        item.confidence_rationale = result.rationale or "(no rationale given)"
        processed.append(item.id)

    return processed
