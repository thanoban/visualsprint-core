"""Proposal queue and approval v2 (F12).

Additions over v1 (app/api/actions.py):
- proposal queue filters by project/customer scope
- approve endpoint enforces payload_hash immutability:
  a changed payload requires a new ProposedAction row, not a re-approval
- double-approval on same action_id returns the original approved row (idempotent)
- rejection endpoint

Architecture rules:
- proposed_action cannot execute without an approval record (DB CHECK constraint,
  not this code).  approved_payload_hash is written atomically with approved_by.
- approved_payload_hash uses sha256(json.dumps(payload, sort_keys=True)).
"""

import hashlib
import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.dependency import (
    get_current_user,
    require_action_access,
    require_org_member,
    resolve_actor_person,
)
from app.db.base import get_db
from app.db.models import (
    ActionStatus,
    CaptureSession,
    MeetingAssignment,
    Org,
    ProjectMember,
    ProposedAction,
    User,
)
from app.modules.projects.access import visible_meeting_ids

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["actions-v2"])


def _payload_hash(payload: dict[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class ProposalView(BaseModel):
    id: str
    kind: str
    title: str
    body: str
    target: dict[str, str]
    status: str
    approved_payload_hash: str | None = None
    external_id: str | None = None
    external_url: str | None = None
    error: str | None = None


class ApproveIn(BaseModel):
    payload_hash: str


def _to_view(action: ProposedAction) -> ProposalView:
    return ProposalView(
        id=action.id,
        kind=action.kind,
        title=action.payload.get("title", ""),
        body=action.payload.get("body", ""),
        target=dict(action.payload.get("target", {})),
        status=action.status.value,
        approved_payload_hash=action.approved_payload_hash,
        external_id=action.external_id,
        external_url=action.external_url,
        error=action.error,
    )


def _require_org(db: Session, org_id: str) -> None:
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "workspace not found")


@router.get("/proposals", response_model=list[ProposalView])
def list_proposals(
    org_id: str,
    status: str | None = None,
    project_id: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> list[ProposalView]:
    """List proposed actions for this org, optionally filtered by status or project.

    If project_id is given, only actions whose capture_session is linked to a
    meeting assigned to that project are returned.  Caller must be a project member.
    """
    _require_org(db, org_id)

    q = select(ProposedAction).where(ProposedAction.org_id == org_id)
    q = q.where(
        ProposedAction.capture_session_id.in_(
            select(CaptureSession.id).where(
                CaptureSession.org_id == org_id,
                CaptureSession.meeting_id.in_(visible_meeting_ids(org_id, user.id)),
            )
        )
    )
    if status is not None:
        try:
            q = q.where(ProposedAction.status == ActionStatus(status))
        except ValueError as exc:
            raise HTTPException(422, f"invalid status: {status}") from exc

    if project_id is not None:
        # Verify caller is project member
        member = db.execute(
            select(ProjectMember).where(
                ProjectMember.org_id == org_id,
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user.id,
            )
        ).scalar_one_or_none()
        if member is None:
            raise HTTPException(404, "project not found")

        # Find meeting IDs assigned to this project
        assigned_meeting_ids = (
            db.execute(
                select(MeetingAssignment.meeting_id).where(
                    MeetingAssignment.org_id == org_id,
                    MeetingAssignment.project_id == project_id,
                )
            )
            .scalars()
            .all()
        )

        # Find capture sessions for those meetings
        session_ids = (
            db.execute(
                select(CaptureSession.id).where(
                    CaptureSession.org_id == org_id,
                    CaptureSession.meeting_id.in_(assigned_meeting_ids),
                )
            )
            .scalars()
            .all()
        )

        q = q.where(ProposedAction.capture_session_id.in_(session_ids))

    rows = db.execute(q.order_by(ProposedAction.created_at.desc())).scalars().all()
    return [_to_view(r) for r in rows]


@router.post("/proposals/{action_id}/approve", response_model=ProposalView)
def approve_proposal(
    org_id: str,
    action_id: str,
    body: ApproveIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> ProposalView:
    """Approve a proposal.  payload_hash must match the action's current payload.

    Idempotent: approving an already-approved action with the same payload_hash
    returns the original row.  A changed payload_hash means the payload was
    modified — this is not allowed; a new ProposedAction must be created.
    Rejected actions cannot be re-approved.
    """
    _require_org(db, org_id)
    action = db.execute(
        select(ProposedAction)
        .where(
            ProposedAction.id == action_id,
            ProposedAction.org_id == org_id,
        )
        .with_for_update()
    ).scalar_one_or_none()
    if action is None:
        raise HTTPException(404, "proposal not found")
    require_action_access(db, action, user)

    expected_hash = _payload_hash(action.payload)
    if body.payload_hash != expected_hash:
        raise HTTPException(409, "payload_hash does not match current payload")

    # Idempotent: already approved with same hash
    if action.status == ActionStatus.APPROVED and action.approved_payload_hash == expected_hash:
        return _to_view(action)

    if action.status not in (ActionStatus.PENDING_APPROVAL, ActionStatus.FAILED):
        raise HTTPException(409, f"proposal is not approvable (status={action.status.value})")

    actor_person_id = resolve_actor_person(db, org_id, user)
    action.approved_by_person_id = actor_person_id
    action.approved_payload_hash = expected_hash
    action.status = ActionStatus.APPROVED
    action.approved_at = datetime.now(UTC)
    db.commit()
    return _to_view(action)


@router.post("/proposals/{action_id}/reject", status_code=204)
def reject_proposal(
    org_id: str,
    action_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: None = Depends(require_org_member),
) -> None:
    """Reject a pending proposal.  Idempotent if already rejected."""
    _require_org(db, org_id)
    action = db.execute(
        select(ProposedAction)
        .where(
            ProposedAction.id == action_id,
            ProposedAction.org_id == org_id,
        )
        .with_for_update()
    ).scalar_one_or_none()
    if action is None:
        raise HTTPException(404, "proposal not found")
    require_action_access(db, action, user)
    if action.status == ActionStatus.REJECTED:
        return
    if action.status not in (ActionStatus.PENDING_APPROVAL,):
        raise HTTPException(409, f"proposal cannot be rejected (status={action.status.value})")
    action.status = ActionStatus.REJECTED
    db.commit()
