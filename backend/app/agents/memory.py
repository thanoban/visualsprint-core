"""Memory Intelligence — links a verified item against org history.

Finds related prior KnowledgeItems (pgvector cosine similarity when an
embedding is available, plus simple keyword overlap as a fallback/booster —
full hybrid search is a later phase), then asks the LLM to assign a
lifecycle_state and propose KnowledgeEdge rows explaining the relationship.

Model tier: Opus (settings.model_memory) — this stage makes judgment calls
across a growing corpus of history, worth the higher-cost tier.
"""

import re

import structlog
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.models import (
    Confidence,
    EdgeKind,
    KnowledgeEdge,
    KnowledgeItem,
    LifecycleState,
)
from app.interfaces.llm import LlmClient

log = structlog.get_logger()

SYSTEM_PROMPT = """You are Memory Intelligence for a meeting-intelligence platform.
Given a newly verified knowledge item and a shortlist of possibly-related prior items
from the same organization's history, decide:
1. lifecycle_state for the new item: new, recurring, reopened, resolved, or superseded.
2. Any edges to prior items: supersedes, contradicts, continues, recurs, resolves.
Only propose an edge to an item id that appears in the provided related-items list.
Give a rationale for each edge. If nothing is related, propose lifecycle_state=new and
no edges."""

_STOPWORDS = {
    "the",
    "a",
    "an",
    "to",
    "of",
    "and",
    "or",
    "is",
    "are",
    "was",
    "were",
    "in",
    "on",
    "for",
    "with",
    "we",
    "will",
    "be",
    "by",
    "at",
    "this",
    "that",
    "our",
}


class RelatedItem(BaseModel):
    id: str
    type: str
    statement: str
    lifecycle_state: str


class MemoryQuery(BaseModel):
    item: RelatedItem
    related: list[RelatedItem]


class EdgeProposal(BaseModel):
    to_item_id: str
    kind: EdgeKind
    rationale: str


class MemoryDecision(BaseModel):
    lifecycle_state: LifecycleState
    edges: list[EdgeProposal] = []


def _keywords(text: str) -> set[str]:
    tokens = re.findall(r"[a-zA-Z0-9']+", text.lower())
    return {t for t in tokens if t not in _STOPWORDS and len(t) > 2}


def _find_related(db: Session, item: KnowledgeItem, limit: int = 8) -> list[KnowledgeItem]:
    """Keyword-overlap shortlist scoped to the org, excluding the item's own session.

    When `item.embedding` is populated, callers may extend this with a pgvector
    cosine-distance query (`KnowledgeItem.embedding.cosine_distance(...)`); kept
    keyword-only for now per the "simple keyword overlap is fine" scope note.
    """
    item_keywords = _keywords(item.statement)
    if not item_keywords:
        return []
    prior = (
        db.query(KnowledgeItem)
        .filter(
            KnowledgeItem.org_id == item.org_id,
            KnowledgeItem.id != item.id,
            KnowledgeItem.capture_session_id != item.capture_session_id,
            KnowledgeItem.confidence.in_([Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED]),
        )
        .all()
    )
    scored = []
    for candidate in prior:
        overlap = len(item_keywords & _keywords(candidate.statement))
        if overlap > 0:
            scored.append((overlap, candidate))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [c for _, c in scored[:limit]]


async def run_memory_intelligence(
    db: Session,
    capture_session_id: str,
    llm: LlmClient,
    model: str | None = None,
) -> list[str]:
    """Process verified/partially_supported items for a session; returns processed ids."""
    items = (
        db.query(KnowledgeItem)
        .filter(
            KnowledgeItem.capture_session_id == capture_session_id,
            KnowledgeItem.confidence.in_([Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED]),
        )
        .all()
    )
    if not items:
        return []

    from app.config import get_settings

    model = model or get_settings().model_memory
    processed: list[str] = []
    for item in items:
        related = _find_related(db, item)
        related_by_id = {r.id: r for r in related}
        user_content = MemoryQuery(
            item=RelatedItem(
                id=item.id,
                type=item.type.value,
                statement=item.statement,
                lifecycle_state=item.lifecycle_state.value,
            ),
            related=[
                RelatedItem(
                    id=r.id,
                    type=r.type.value,
                    statement=r.statement,
                    lifecycle_state=r.lifecycle_state.value,
                )
                for r in related
            ],
        ).model_dump_json()

        decision, usage = await llm.complete_structured(
            model=model,
            system=SYSTEM_PROMPT,
            user_content=user_content,
            schema=MemoryDecision,
        )
        log.info(
            "memory.decided",
            item=item.id,
            lifecycle_state=decision.lifecycle_state,
            edges=len(decision.edges),
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
        )
        item.lifecycle_state = decision.lifecycle_state

        for edge in decision.edges:
            if edge.to_item_id not in related_by_id:
                log.warning(
                    "memory.edge_dropped_unknown_target", item=item.id, target=edge.to_item_id
                )
                continue
            exists = (
                db.query(KnowledgeEdge)
                .filter(
                    KnowledgeEdge.from_item_id == item.id,
                    KnowledgeEdge.to_item_id == edge.to_item_id,
                    KnowledgeEdge.kind == edge.kind,
                )
                .one_or_none()
            )
            if exists is not None:
                continue
            db.add(
                KnowledgeEdge(
                    org_id=item.org_id,
                    from_item_id=item.id,
                    to_item_id=edge.to_item_id,
                    kind=edge.kind,
                    rationale=edge.rationale,
                )
            )
        processed.append(item.id)

    return processed
