"""Deterministic action triggers -- app/agents/action.py's LLM-driven
drafting runs once, right after a capture_session's knowledge items are
extracted; it has no way to notice that a blocker has since recurred
across later meetings, or that a commitment's due date is now approaching.
This module is the periodic counterpart for exactly the two triggers
docs/PROJECT_PLAN.md's automation table describes as time-driven rather
than extraction-driven:

- Blocker escalation: any BLOCKER item Memory Intelligence has already
  judged to have recurred (lifecycle_state=RECURRING -- see
  app/agents/memory.py) gets one ESCALATION action.
- Commitment reminder: any still-open COMMITMENT item with a resolvable
  owner email and a due_at at or before `within_hours` from now
  (including already-overdue ones) gets one REMINDER action.

No LLM call needed for either -- the signal itself (a lifecycle_state, a
due_at) already says everything the action needs to say, which also means
these are structurally incapable of hallucinating a trigger that isn't
really there. Deterministic software deciding when to propose, per
CLAUDE.md rule 1 -- the LLM path in action.py is for judgment-heavy kind
selection on freshly-extracted items, this path is for pure fact-checking
against already-verified state.

Idempotent: dedups per (item_id, kind) against existing ProposedAction
rows, same convention as action.py's `already_actioned` set -- but scoped
org-wide rather than per capture_session, since these triggers fire long
after the originating meeting, not right after it.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    ActionStatus,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Person,
    ProposedAction,
)
from app.interfaces.actions import ActionKind


def _already_proposed(db: Session, org_id: str) -> set[tuple[str, str]]:
    rows = db.execute(select(ProposedAction).where(ProposedAction.org_id == org_id)).scalars().all()
    pairs: set[tuple[str, str]] = set()
    for row in rows:
        for item_id in row.payload.get("evidence_item_ids", []):
            pairs.add((item_id, row.kind))
    return pairs


def propose_recurring_blocker_escalations(db: Session, org_id: str) -> list[str]:
    """Does not commit -- caller owns the transaction, same convention as
    every other orchestrator sweep in this codebase."""
    already = _already_proposed(db, org_id)
    items = (
        db.execute(
            select(KnowledgeItem).where(
                KnowledgeItem.org_id == org_id,
                KnowledgeItem.type == KnowledgeType.BLOCKER,
                KnowledgeItem.lifecycle_state == LifecycleState.RECURRING,
            )
        )
        .scalars()
        .all()
    )

    created: list[str] = []
    for item in items:
        if (item.id, ActionKind.ESCALATION.value) in already:
            continue
        action = ProposedAction(
            org_id=org_id,
            capture_session_id=item.capture_session_id,
            kind=ActionKind.ESCALATION.value,
            payload={
                "title": f"Recurring blocker: {item.statement[:80]}",
                "body": (
                    "This blocker has recurred across meetings and is still "
                    f"unresolved:\n\n{item.statement}"
                ),
                "target": {},
                "evidence_item_ids": [item.id],
            },
            status=ActionStatus.PENDING_APPROVAL,
        )
        db.add(action)
        db.flush()
        created.append(action.id)
    return created


def propose_commitment_reminders(
    db: Session, org_id: str, *, within_hours: float = 24.0, now: datetime | None = None
) -> list[str]:
    """Does not commit -- caller owns the transaction."""
    now = now or datetime.now(UTC)
    horizon = now + timedelta(hours=within_hours)
    already = _already_proposed(db, org_id)

    items = (
        db.execute(
            select(KnowledgeItem).where(
                KnowledgeItem.org_id == org_id,
                KnowledgeItem.type == KnowledgeType.COMMITMENT,
                KnowledgeItem.lifecycle_state != LifecycleState.RESOLVED,
                KnowledgeItem.due_at.is_not(None),
                KnowledgeItem.due_at <= horizon,
            )
        )
        .scalars()
        .all()
    )

    created: list[str] = []
    for item in items:
        if (item.id, ActionKind.REMINDER.value) in already:
            continue
        if item.owner_person_id is None:
            continue
        owner = db.get(Person, item.owner_person_id)
        if owner is None or not owner.email:
            continue  # no resolvable recipient -- nothing a reminder draft can do
        action = ProposedAction(
            org_id=org_id,
            capture_session_id=item.capture_session_id,
            kind=ActionKind.REMINDER.value,
            payload={
                "title": f"Reminder: {item.statement[:80]}",
                "body": f"This commitment is due soon:\n\n{item.statement}",
                "target": {"to": owner.email},
                "evidence_item_ids": [item.id],
            },
            status=ActionStatus.PENDING_APPROVAL,
        )
        db.add(action)
        db.flush()
        created.append(action.id)
    return created
