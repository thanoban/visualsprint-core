"""Typed, transcript-free payloads shared by person-scoped agents."""

from datetime import datetime

from pydantic import BaseModel, Field

from app.db.models import Confidence, KnowledgeType, LifecycleState


class LongitudinalEvidenceItem(BaseModel):
    id: str
    type: KnowledgeType
    statement: str
    lifecycle_state: LifecycleState
    confidence: Confidence
    meeting_at: datetime
    due_at: datetime | None = None
    edge_rationales: list[str] = Field(default_factory=list)
    blocker_item_ids: list[str] = Field(default_factory=list)
    work_statuses: list[str] = Field(default_factory=list)


class AuditableClaim(BaseModel):
    claim_id: str
    statement: str
    evidence_item_ids: list[str]
    confidence: Confidence = Confidence.AMBIGUOUS


def unanimous_or_none[T: BaseModel](results: list[T]) -> T | None:
    """High-stakes claims emit only when all zero-temperature samples agree."""

    if not results:
        return None
    canonical = results[0].model_dump(mode="json", exclude={"rationale"})
    return results[0] if all(
        result.model_dump(mode="json", exclude={"rationale"}) == canonical
        for result in results[1:]
    ) else None
