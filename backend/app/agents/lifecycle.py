"""Deterministic lifecycle derivation for KnowledgeItem rows.

Memory Intelligence may propose relationships, but item state is a pure
projection of verified inbound edges. This is what closes older commitments
when a later meeting resolves them, and it keeps unsupported model guesses
from changing accountability state.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Confidence, EdgeKind, KnowledgeEdge, KnowledgeItem, LifecycleState

STATE_CHANGING_EDGES = {
    EdgeKind.RESOLVES,
    EdgeKind.SUPERSEDES,
    EdgeKind.RECURS,
    EdgeKind.CONTINUES,
}
STATE_SOURCE_CONFIDENCES = {Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED}


def _next_state(current: LifecycleState, edge_kind: EdgeKind) -> LifecycleState:
    if edge_kind == EdgeKind.RESOLVES:
        return LifecycleState.RESOLVED
    if edge_kind == EdgeKind.SUPERSEDES:
        return LifecycleState.SUPERSEDED
    if edge_kind in (EdgeKind.RECURS, EdgeKind.CONTINUES):
        return (
            LifecycleState.REOPENED
            if current == LifecycleState.RESOLVED
            else LifecycleState.RECURRING
        )
    return current


def derive_lifecycle_state(db: Session, item_id: str) -> LifecycleState:
    rows = db.execute(
        select(KnowledgeEdge, KnowledgeItem)
        .join(KnowledgeItem, KnowledgeItem.id == KnowledgeEdge.from_item_id)
        .where(
            KnowledgeEdge.to_item_id == item_id,
            KnowledgeEdge.kind.in_(STATE_CHANGING_EDGES),
            KnowledgeItem.confidence.in_(STATE_SOURCE_CONFIDENCES),
        )
        .order_by(KnowledgeItem.created_at, KnowledgeEdge.created_at, KnowledgeEdge.id)
    ).all()
    state = LifecycleState.NEW
    for edge, _source in rows:
        state = _next_state(state, edge.kind)
    return state


def derive_lifecycle_states_for_items(
    db: Session, item_ids: set[str] | list[str]
) -> dict[str, LifecycleState]:
    changed: dict[str, LifecycleState] = {}
    for item_id in item_ids:
        item = db.get(KnowledgeItem, item_id)
        if item is None:
            continue
        derived = derive_lifecycle_state(db, item.id)
        if item.lifecycle_state != derived:
            item.lifecycle_state = derived
            changed[item.id] = derived
    db.flush()
    return changed


def sweep_org_lifecycle(db: Session, org_id: str) -> dict[str, LifecycleState]:
    item_ids = (
        db.execute(select(KnowledgeItem.id).where(KnowledgeItem.org_id == org_id)).scalars().all()
    )
    return derive_lifecycle_states_for_items(db, set(item_ids))
