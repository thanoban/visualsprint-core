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

from app.connectors.errors import ConnectorError
from app.db.base import get_db
from app.db.models import ActionStatus, Org, Person, ProposedAction
from app.interfaces.actions import ActionKind, ActionPayload

router = APIRouter(prefix="/api/v1", tags=["actions"])

_connectors: dict[str, object] = {}


def _get_connector(kind: ActionKind):
    """Lazy per-kind singleton, same pattern as worker.py's
    `_get_platform_adapters` — real credentials aren't configured yet, so
    every connector is wired with `UnconfiguredTokenProvider` and fails
    loudly and clearly inside `execute()` rather than here."""
    if kind.value not in _connectors:
        from app.capture.token_provider import UnconfiguredTokenProvider

        if kind == ActionKind.EMAIL_DRAFT:
            from app.connectors.email_draft import EmailDraftConnector

            _connectors[kind.value] = EmailDraftConnector(
                token_provider=UnconfiguredTokenProvider("Gmail OAuth not configured"),
            )
        elif kind == ActionKind.CHANNEL_RECAP:
            from app.connectors.channel_recap import ChannelRecapConnector

            _connectors[kind.value] = ChannelRecapConnector(
                slack_token_provider=UnconfiguredTokenProvider("Slack bot token not configured"),
            )
        elif kind == ActionKind.TASK_CREATE:
            from app.connectors.task_create import TaskCreateConnector

            _connectors[kind.value] = TaskCreateConnector(
                jira_token_provider=UnconfiguredTokenProvider("Jira API token not configured"),
                github_token_provider=UnconfiguredTokenProvider("GitHub PAT not configured"),
                linear_token_provider=UnconfiguredTokenProvider("Linear API key not configured"),
            )
        elif kind == ActionKind.CALENDAR_FOLLOWUP:
            from app.connectors.calendar_followup import CalendarFollowupConnector

            _connectors[kind.value] = CalendarFollowupConnector(
                token_provider=UnconfiguredTokenProvider("Google Calendar OAuth not configured"),
            )
        else:
            # ESCALATION / REMINDER are valid ActionKind values (Action
            # Intelligence may propose them) but have no connector
            # implementation yet -- approval still records cleanly, only
            # execution is unavailable.
            raise ConnectorError(f"no connector implemented yet for action kind {kind.value!r}")
    return _connectors[kind.value]


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
        external_url=action.external_url,
        error=action.error,
    )


@router.get("/orgs/{org_id}/actions", response_model=list[ProposedActionOut])
async def list_actions(
    org_id: str, status: str | None = None, db: Session = Depends(get_db)
) -> list[ProposedActionOut]:
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "org not found")

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
    action_id: str, req: ApproveActionRequest, db: Session = Depends(get_db)
) -> ProposedActionOut:
    action = db.get(ProposedAction, action_id)
    if action is None:
        raise HTTPException(404, "action not found")
    if action.status not in (ActionStatus.PENDING_APPROVAL, ActionStatus.FAILED):
        raise HTTPException(409, f"action is not approvable (status={action.status.value})")

    # The approval record itself is written and committed unconditionally,
    # before execution is even attempted -- this is what rule 5 requires,
    # and it's what the DB CHECK constraint is actually checking for.
    action.status = ActionStatus.APPROVED
    action.approved_by_person_id = req.approved_by_person_id
    action.approved_at = datetime.now(UTC)
    action.error = None
    db.commit()

    try:
        kind = ActionKind(action.kind)
        connector = _get_connector(kind)
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
        action.external_url = result.external_url
    except Exception as exc:  # noqa: BLE001 — surfaced on the row, never swallowed silently
        action.status = ActionStatus.FAILED
        action.error = str(exc)
    db.commit()

    return _to_out(db, action)


@router.post("/actions/{action_id}/reject", response_model=ProposedActionOut)
async def reject_action(action_id: str, db: Session = Depends(get_db)) -> ProposedActionOut:
    action = db.get(ProposedAction, action_id)
    if action is None:
        raise HTTPException(404, "action not found")
    if action.status != ActionStatus.PENDING_APPROVAL:
        raise HTTPException(409, f"action is not pending approval (status={action.status.value})")

    action.status = ActionStatus.REJECTED
    db.commit()
    return _to_out(db, action)
