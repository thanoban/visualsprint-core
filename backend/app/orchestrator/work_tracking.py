"""Periodic external work-status verification."""


from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents.lifecycle import derive_lifecycle_states_for_items
from app.db.models import (
    ActionStatus,
    Confidence,
    EdgeKind,
    KnowledgeEdge,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    ProposedAction,
    WorkEvidence,
    WorkStatus,
)
from app.interfaces.actions import ActionKind
from app.interfaces.work_tracker import WorkState, WorkTracker
from app.oauth.connection import build_org_token_provider, get_org_connection


def _tracker_for_action(db: Session, action: ProposedAction) -> WorkTracker | None:
    provider = action.payload.get("target", {}).get("provider")
    if provider == "jira":
        from app.connectors.work_tracker import JiraWorkTracker

        connection = get_org_connection(db, action.org_id, "jira")
        token_provider = build_org_token_provider(db, action.org_id, "jira")
        if connection is None or connection.external_id is None or token_provider is None:
            return None
        return JiraWorkTracker(
            cloud_id=connection.external_id,
            site_url=connection.account_label,
            token_provider=token_provider,
        )
    if provider == "github":
        from app.connectors.work_tracker import GitHubWorkTracker

        target = action.payload.get("target", {})
        token_provider = build_org_token_provider(db, action.org_id, "github")
        if token_provider is None or not target.get("owner") or not target.get("repo"):
            return None
        return GitHubWorkTracker(
            owner=target["owner"], repo=target["repo"], token_provider=token_provider
        )
    if provider == "linear":
        from app.connectors.work_tracker import LinearWorkTracker

        token_provider = build_org_token_provider(db, action.org_id, "linear")
        if token_provider is None:
            return None
        return LinearWorkTracker(token_provider=token_provider)
    return None


def _existing_closed_evidence(db: Session, action_id: str, item_id: str) -> bool:
    return (
        db.execute(
            select(WorkEvidence.id).where(
                WorkEvidence.action_id == action_id,
                WorkEvidence.knowledge_item_id == item_id,
                WorkEvidence.status == WorkStatus.CLOSED,
            )
        ).first()
        is not None
    )


async def sweep_work_tracking(db: Session, org_id: str) -> list[str]:
    """Checks executed task actions and records closure evidence.

    Does not commit. Missing OAuth connections simply skip the action; the
    action row keeps its external_url/id for humans even when automated status
    sync is not configured.
    """
    actions = (
        db.execute(
            select(ProposedAction).where(
                ProposedAction.org_id == org_id,
                ProposedAction.kind == ActionKind.TASK_CREATE.value,
                ProposedAction.status == ActionStatus.EXECUTED,
                ProposedAction.external_id.isnot(None),
            )
        )
        .scalars()
        .all()
    )
    created: list[str] = []
    for action in actions:
        evidence_item_ids = action.payload.get("evidence_item_ids", [])
        if not evidence_item_ids:
            continue
        provider = action.payload.get("target", {}).get("provider", "")
        try:
            tracker = _tracker_for_action(db, action)
            if tracker is None:
                continue
            status = await tracker.check_status(action.external_id)
        except Exception:
            continue
        for item_id in evidence_item_ids:
            item = db.get(KnowledgeItem, item_id)
            if item is None or item.lifecycle_state == LifecycleState.RESOLVED:
                continue
            already_closed = _existing_closed_evidence(db, action.id, item.id)
            work_status = WorkStatus(status.state.value)
            evidence = WorkEvidence(
                org_id=org_id,
                action_id=action.id,
                knowledge_item_id=item.id,
                provider=provider,
                external_id=action.external_id,
                status=work_status,
                status_label=status.label,
                external_url=status.external_url or action.external_url,
                raw=status.raw,
            )
            db.add(evidence)
            db.flush()
            created.append(evidence.id)
            if status.state != WorkState.CLOSED or already_closed:
                continue
            closure_item = KnowledgeItem(
                org_id=org_id,
                capture_session_id=item.capture_session_id,
                type=KnowledgeType.FACT,
                statement=f"{provider.title()} work item {action.external_id} is closed.",
                confidence=Confidence.VERIFIED,
                confidence_rationale="External work tracker reported the item closed.",
            )
            db.add(closure_item)
            db.flush()
            db.add(
                KnowledgeEdge(
                    org_id=org_id,
                    from_item_id=closure_item.id,
                    to_item_id=item.id,
                    kind=EdgeKind.RESOLVES,
                    rationale="The linked external work item is closed.",
                )
            )
            derive_lifecycle_states_for_items(db, {item.id, closure_item.id})
    return created
