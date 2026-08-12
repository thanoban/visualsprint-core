"""Memory Intelligence — links a verified item against org history.

Finds related prior KnowledgeItems via hybrid search: pgvector cosine
similarity (when an `Embedder` is injected — see `run_memory_intelligence`)
merged with simple keyword overlap as a fallback/booster. On first seeing an
item with no `embedding` yet, this stage populates it from `item.statement` —
this is the only writer of `KnowledgeItem.embedding` in the pipeline, which is
also what makes chat's `_vector_candidates` (app/api/chat.py) find anything.

Model tier: Opus (settings.model_memory) — this stage makes judgment calls
across a growing corpus of history, worth the higher-cost tier.
"""

import re

import structlog
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.agents.lifecycle import derive_lifecycle_states_for_items
from app.db.models import (
    Confidence,
    EdgeKind,
    KnowledgeEdge,
    KnowledgeItem,
    LifecycleState,
)
from app.interfaces.embedder import Embedder
from app.interfaces.llm import LlmClient

log = structlog.get_logger()
PROMPT_VERSION = "memory-v1"

SYSTEM_PROMPT = """You are Memory Intelligence for a meeting-intelligence platform.
Given a newly verified knowledge item and a shortlist of possibly-related prior items
from the same organization's history, decide:
1. Any edges to related items: supersedes, contradicts, continues, recurs, resolves,
   or blocks.
2. A lifecycle_state for compatibility with the response schema. The app ignores this
   field and derives lifecycle from verified inbound edges after writing them.
Only propose an edge to an item id that appears in the provided related-items list.
Give a rationale for each edge. Use blocks for blocker -> commitment/dependency links,
including within the same meeting. If nothing is related, propose lifecycle_state=new
and no edges. Set abstained=true when the evidence cannot support an edge."""

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
    abstained: bool = False


def _keywords(text: str) -> set[str]:
    tokens = re.findall(r"[a-zA-Z0-9']+", text.lower())
    return {t for t in tokens if t not in _STOPWORDS and len(t) > 2}


def _vector_related(
    db: Session, item: KnowledgeItem, embedding: list[float], limit: int
) -> list[KnowledgeItem]:
    """pgvector cosine-similarity search, same dialect guard as
    app.api.chat._vector_candidates (SQLite test DBs can't represent the
    pgvector `Vector` column, so this returns [] there rather than erroring)."""
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return []
    return (
        db.query(KnowledgeItem)
        .filter(
            KnowledgeItem.org_id == item.org_id,
            KnowledgeItem.id != item.id,
            KnowledgeItem.confidence.in_([Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED]),
            KnowledgeItem.embedding.isnot(None),
        )
        .order_by(KnowledgeItem.embedding.cosine_distance(embedding))
        .limit(limit)
        .all()
    )


def _find_related(
    db: Session, item: KnowledgeItem, embedding: list[float] | None = None, limit: int = 8
) -> list[KnowledgeItem]:
    """Hybrid shortlist scoped to the org, including the item's own session:
    pgvector similarity (when `embedding` is given and the dialect supports
    it) merged ahead of a keyword-overlap fallback/booster, deduped by id."""
    vector_matches = _vector_related(db, item, embedding, limit) if embedding is not None else []

    item_keywords = _keywords(item.statement)
    keyword_matches: list[KnowledgeItem] = []
    if item_keywords:
        prior = (
            db.query(KnowledgeItem)
            .filter(
                KnowledgeItem.org_id == item.org_id,
                KnowledgeItem.id != item.id,
                KnowledgeItem.confidence.in_([Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED]),
            )
            .all()
        )
        scored = [
            (len(item_keywords & _keywords(c.statement)), c)
            for c in prior
            if len(item_keywords & _keywords(c.statement)) > 0
        ]
        scored.sort(key=lambda pair: pair[0], reverse=True)
        keyword_matches = [c for _, c in scored]

    seen: set[str] = set()
    merged: list[KnowledgeItem] = []
    for candidate in [*vector_matches, *keyword_matches]:
        if candidate.id not in seen:
            seen.add(candidate.id)
            merged.append(candidate)
    return merged[:limit]


async def run_memory_intelligence(
    db: Session,
    capture_session_id: str,
    llm: LlmClient,
    model: str | None = None,
    embedder: Embedder | None = None,
) -> list[str]:
    """Process verified/partially_supported items for a session; returns processed ids.

    When `embedder` is given, populates `item.embedding` the first time this
    stage sees an item without one (never re-embeds an item that already has
    one — `item.statement` shouldn't change after verification) and folds
    pgvector similarity into `_find_related`. `embedder=None` degrades to
    keyword-overlap-only related-item search — same "optional enhancement,
    never a hard requirement" rule the ASR repair pass follows.
    """
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
        if embedder is not None and item.embedding is None:
            item.embedding = await embedder.embed(item.statement)
            db.flush()
        related = _find_related(db, item, embedding=item.embedding)
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
            suggested_lifecycle_state=decision.lifecycle_state,
            edges=len(decision.edges),
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
        )

        lifecycle_targets = {item.id}
        for edge in ([] if decision.abstained else decision.edges):
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
            lifecycle_targets.add(edge.to_item_id)
        derive_lifecycle_states_for_items(db, lifecycle_targets)
        processed.append(item.id)

    return processed
