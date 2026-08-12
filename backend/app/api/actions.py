"""Action-approval UI backend — the human gate for proposed_action rows.

CLAUDE.md rule 5: `proposed_action` cannot execute without an approval
record, enforced by the DB CHECK constraint `ck_action_requires_approval` —
not by this router's discipline. Approving always succeeds and is recorded
even when the subsequent execution attempt fails (no credentials configured
yet, matching every other vendor integration in this codebase); a failed
execution is visible via `status=FAILED` + `error`, and can be retried by
calling approve again.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import dependency as auth_dep
from app.auth.dependency import get_current_user, require_org_member
from app.connectors.errors import ConnectorError
from app.db.base import get_db
from app.db.models import ActionStatus, Person, ProposedAction, User
from app.interfaces.actions import ActionKind, ActionPayload
from app.oauth.connection import build_org_token_provider as _build_org_token_provider
from app.oauth.connection import get_org_connection as _get_org_connection
from app.orchestrator.audit import log_audit_event

router = APIRouter(prefix="/api/v1", tags=["actions"])


def _get_connector(db: Session, org_id: str, kind: ActionKind):
    """Built fresh per call, not cached -- unlike before real OAuth
    existed, which org's connection backs a connector can change at any
    time (connect/reconnect a vendor), and this only runs when a human
    clicks Approve, not a hot path where rebuilding a few small objects
    plus one or two indexed queries would matter."""
    from app.capture.token_provider import UnconfiguredTokenProvider

    def _token_provider_for(provider: str, reason: str):
        return _build_org_token_provider(db, org_id, provider) or UnconfiguredTokenProvider(reason)

    if kind == ActionKind.EMAIL_DRAFT:
        from app.connectors.email_draft import EmailDraftConnector

        return EmailDraftConnector(
            token_provider=_token_provider_for("google", "Gmail OAuth not configured")
        )
    if kind == ActionKind.CHANNEL_RECAP:
        from app.connectors.channel_recap import ChannelRecapConnector

        return ChannelRecapConnector(
            slack_token_provider=_token_provider_for("slack", "Slack bot token not configured")
        )
    if kind == ActionKind.TASK_CREATE:
        from app.connectors.task_create import TaskCreateConnector

        jira_connection = _get_org_connection(db, org_id, "jira")
        return TaskCreateConnector(
            jira_cloud_id=jira_connection.external_id if jira_connection else None,
            jira_site_url=jira_connection.account_label if jira_connection else None,
            jira_token_provider=_token_provider_for("jira", "Jira API token not configured"),
            github_token_provider=_token_provider_for("github", "GitHub PAT not configured"),
            linear_token_provider=_token_provider_for("linear", "Linear API key not configured"),
        )
    if kind == ActionKind.CALENDAR_FOLLOWUP:
        from app.connectors.calendar_followup import CalendarFollowupConnector

        return CalendarFollowupConnector(
            token_provider=_token_provider_for("google", "Google Calendar OAuth not configured")
        )
    if kind == ActionKind.ESCALATION:
        from app.connectors.escalation import EscalationConnector

        return EscalationConnector(
            slack_token_provider=_token_provider_for("slack", "Slack bot token not configured")
        )
    if kind == ActionKind.REMINDER:
        from app.connectors.reminder import ReminderConnector

        return ReminderConnector(
            token_provider=_token_provider_for("google", "Gmail OAuth not configured")
        )
    # Defensive fallback for a future ActionKind added to the enum without a
    # matching branch here -- every current kind has one.
    raise ConnectorError(f"no connector implemented yet for action kind {kind.value!r}")


class ProposedActionOut(BaseModel):
    id: str
    capture_session_id: str
    kind: str
    title: str
    body: str
    target: dict[str, str]
    status: str
    approved_by: str | None = None
    approved_at: str | None = None
    executed_at: str | None = None
    external_id: str | None = None
    external_url: str | None = None
    error: str | None = None


def _to_out(db: Session, action: ProposedAction) -> ProposedActionOut:
    approved_by = None
    if action.approved_by_person_id:
        person = db.get(Person, action.approved_by_person_id)
        approved_by = person.display_name if person else None
    return ProposedActionOut(
        id=action.id,
        capture_session_id=action.capture_session_id,
        kind=action.kind,
        title=action.payload.get("title", ""),
        body=action.payload.get("body", ""),
        target=action.payload.get("target", {}),
        status=action.status.value,
        approved_by=approved_by,
        approved_at=action.approved_at.isoformat() if action.approved_at else None,
        executed_at=action.executed_at.isoformat() if action.executed_at else None,
        external_id=action.external_id,
        external_url=action.external_url,
        error=action.error,
    )


@router.get("/orgs/{org_id}/actions", response_model=list[ProposedActionOut])
async def list_actions(
    org_id: str,
    status: str | None = None,
    db: Session = Depends(get_db),
    _: None = Depends(require_org_member),
) -> list[ProposedActionOut]:
    q = db.query(ProposedAction).filter(ProposedAction.org_id == org_id)
    if status:
        try:
            status_enum = ActionStatus(status)
        except ValueError as exc:
            raise HTTPException(400, f"invalid status {status!r}") from exc
        q = q.filter(ProposedAction.status == status_enum)

    rows = q.order_by(ProposedAction.created_at.desc()).all()
    return [_to_out(db, r) for r in rows]


class ApproveActionRequest(BaseModel):
    approved_by_person_id: str | None = None


@router.post("/actions/{action_id}/approve", response_model=ProposedActionOut)
async def approve_action(
    action_id: str,
    req: ApproveActionRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ProposedActionOut:
    # org_id isn't a path/body param here -- it only exists on the action
    # row itself once looked up, so this can't use Depends(require_org_member)
    # the way path-param routes do; same reasoning as chat.py/upload.py.
    action = db.get(ProposedAction, action_id)
    if action is None:
        raise HTTPException(404, "action not found")
    if not auth_dep.is_org_member(db, action.org_id, user):
        raise HTTPException(403, "not a member of this org")
    if action.status not in (ActionStatus.PENDING_APPROVAL, ActionStatus.FAILED):
        raise HTTPException(409, f"action is not approvable (status={action.status.value})")

    # The approval record itself is written and committed unconditionally,
    # before execution is even attempted -- this is what rule 5 requires,
    # and it's what the DB CHECK constraint is actually checking for.
    action.status = ActionStatus.APPROVED
    action.approved_by_person_id = req.approved_by_person_id
    action.approved_at = datetime.now(UTC)
    action.error = None
    # No title/body here: those are meeting-content-derived free text with
    # no purge path once written to an AuditLog row (no FK to the source
    # meeting/knowledge item for a later erasure to find and scrub) -- the
    # action_id is enough for the audit trail to prove what happened.
    log_audit_event(
        db,
        org_id=action.org_id,
        actor=req.approved_by_person_id or "system",
        event="action_approved",
        detail={"action_id": action.id, "kind": action.kind},
    )
    db.commit()

    try:
        kind = ActionKind(action.kind)
        connector = _get_connector(db, action.org_id, kind)
        payload = ActionPayload(
            kind=kind,
            title=action.payload.get("title", ""),
            body=action.payload.get("body", ""),
            target=action.payload.get("target", {}),
            evidence_item_ids=action.payload.get("evidence_item_ids", []),
        )
        result = await connector.execute(payload)
        action.status = ActionStatus.EXECUTED
        action.executed_at = datetime.now(UTC)
        action.external_id = result.external_id
        action.external_url = result.external_url
    except Exception as exc:  # noqa: BLE001 — surfaced on the row, never swallowed silently
        action.status = ActionStatus.FAILED
        action.error = str(exc)
    db.commit()

    return _to_out(db, action)


class RejectActionRequest(BaseModel):
    rejected_by_person_id: str | None = None


@router.post("/actions/{action_id}/reject", response_model=ProposedActionOut)
async def reject_action(
    action_id: str,
    req: RejectActionRequest = RejectActionRequest(),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ProposedActionOut:
    action = db.get(ProposedAction, action_id)
    if action is None:
        raise HTTPException(404, "action not found")
    if not auth_dep.is_org_member(db, action.org_id, user):
        raise HTTPException(403, "not a member of this org")
    if action.status != ActionStatus.PENDING_APPROVAL:
        raise HTTPException(409, f"action is not pending approval (status={action.status.value})")

    action.status = ActionStatus.REJECTED
    # See approve_action's comment above -- same reasoning against storing
    # free-text content in an AuditLog row that has no purge path.
    log_audit_event(
        db,
        org_id=action.org_id,
        actor=req.rejected_by_person_id or "system",
        event="action_rejected",
        detail={"action_id": action.id, "kind": action.kind},
    )
    db.commit()
    return _to_out(db, action)
