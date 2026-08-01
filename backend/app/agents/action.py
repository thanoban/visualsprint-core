"""Action Intelligence — proposes automations from verified knowledge.

Looks at commitments with a resolved owner and unresolved blockers, and asks
the LLM (Haiku tier — this is a cheap classification/drafting task) to draft
a `ProposedAction`. Every row is written with `status=PENDING_APPROVAL` —
never anything else. That is also enforced by the DB CHECK constraint
`ck_action_requires_approval` on `proposed_action`, so even a bug here
cannot produce an auto-executed action; this module just never tries.
"""

import structlog
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.models import (
    ActionStatus,
    Confidence,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    ProposedAction,
)
from app.interfaces.actions import ActionKind
from app.interfaces.llm import LlmClient

log = structlog.get_logger()

SYSTEM_PROMPT = """You are Action Intelligence for a meeting-intelligence platform.
Given one verified knowledge item, propose ONE automation: draft the title and body
text, pick the most appropriate kind, and note a target hint (e.g. a channel name or
assignee) if apparent from the statement. Never claim this action has already run —
you are drafting a suggestion for a human to approve."""


class ActionDraft(BaseModel):
    kind: ActionKind
    title: str
    body: str
    target_hint: str = ""


def _eligible(item: KnowledgeItem) -> bool:
    if item.confidence not in (Confidence.VERIFIED, Confidence.PARTIALLY_SUPPORTED):
        return False
    if item.type == KnowledgeType.COMMITMENT and item.owner_person_id is not None:
        return True
    return item.type == KnowledgeType.BLOCKER and item.lifecycle_state != LifecycleState.RESOLVED


async def run_action_intelligence(
    db: Session,
    capture_session_id: str,
    llm: LlmClient,
    model: str | None = None,
) -> list[str]:
    """Propose actions for eligible items in a session; returns created ProposedAction ids."""
    items = (
        db.query(KnowledgeItem).filter(KnowledgeItem.capture_session_id == capture_session_id).all()
    )
    eligible = [i for i in items if _eligible(i)]
    if not eligible:
        return []

    existing = (
        db.query(ProposedAction)
        .filter(ProposedAction.capture_session_id == capture_session_id)
        .all()
    )
    already_actioned = {
        item_id for row in existing for item_id in row.payload.get("evidence_item_ids", [])
    }

    from app.config import get_settings

    model = model or get_settings().model_classify
    created: list[str] = []
    for item in eligible:
        if item.id in already_actioned:
            continue
        draft, usage = await llm.complete_structured(
            model=model,
            system=SYSTEM_PROMPT,
            user_content=f"type={item.type.value}\nstatement={item.statement}\nowner_person_id={item.owner_person_id}",
            schema=ActionDraft,
        )
        log.info(
            "action.drafted",
            item=item.id,
            kind=draft.kind,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
        )
        action = ProposedAction(
            org_id=item.org_id,
            capture_session_id=capture_session_id,
            kind=draft.kind.value,
            payload={
                "title": draft.title,
                "body": draft.body,
                "target": {"hint": draft.target_hint} if draft.target_hint else {},
                "evidence_item_ids": [item.id],
            },
            status=ActionStatus.PENDING_APPROVAL,
        )
        db.add(action)
        db.flush()
        created.append(action.id)

    return created
