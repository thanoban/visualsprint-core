"""Tests for F12 proposals v2 API — payload-hash immutability, scoped listing."""

import hashlib
import json
from datetime import UTC, datetime

import pytest
from sqlalchemy.exc import IntegrityError

from app.auth import dependency as auth_dep
from app.db.models import (
    ActionStatus,
    CaptureSession,
    CaptureState,
    Meeting,
    MeetingAssignment,
    Org,
    OrgMember,
    Person,
    Project,
    ProjectMember,
    ProposedAction,
    User,
)
from app.main import app

USER_1 = "44444444-4444-4444-4444-444444444441"
USER_2 = "44444444-4444-4444-4444-444444444442"

_PAYLOAD = {"title": "Create Jira issue", "body": "Track Q4 decision", "target": {"key": "val"}}


def _hash(payload: dict) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _seed(db):
    org = Org(name="ActV2Org")
    db.add(org)
    db.flush()
    db.add_all(
        [
            User(id=USER_1, email="founder@example.com"),
            User(id=USER_2, email="other@example.com"),
        ]
    )
    db.flush()
    db.add_all(
        [
            OrgMember(org_id=org.id, user_id=USER_1, role="owner"),
            OrgMember(org_id=org.id, user_id=USER_2, role="member"),
        ]
    )
    db.flush()
    return org


def _as(user_id: str, email: str = "founder@example.com") -> None:
    app.dependency_overrides[auth_dep.get_current_user] = lambda: User(id=user_id, email=email)


def _make_action(db, org_id: str, payload: dict | None = None) -> ProposedAction:
    meeting = Meeting(org_id=org_id, title="Sprint Review", platform="zoom")
    db.add(meeting)
    db.flush()
    session = CaptureSession(
        org_id=org_id,
        meeting_id=meeting.id,
        mode="D",
        state=CaptureState.DONE,
    )
    db.add(session)
    db.flush()
    action = ProposedAction(
        org_id=org_id,
        capture_session_id=session.id,
        kind="jira_create_issue",
        payload=payload or _PAYLOAD,
        status=ActionStatus.PENDING_APPROVAL,
    )
    db.add(action)
    db.flush()
    return action


def _project_with_meeting(db, org_id: str, owner_id: str, action: ProposedAction) -> Project:
    """Create project, add owner as member, assign the action's meeting to it."""
    p = Project(org_id=org_id, name="Proj", visibility="private", status="active", version=1)
    db.add(p)
    db.flush()
    db.add(ProjectMember(org_id=org_id, project_id=p.id, user_id=owner_id, role="owner"))
    session = db.get(CaptureSession, action.capture_session_id)
    db.add(
        MeetingAssignment(
            org_id=org_id,
            project_id=p.id,
            meeting_id=session.meeting_id,
            assigned_by=owner_id,
        )
    )
    db.flush()
    return p


# ---------------------------------------------------------------------------
# List proposals
# ---------------------------------------------------------------------------


def test_list_proposals_empty(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_1)

    resp = client.get(f"/api/v2/workspaces/{org.id}/proposals")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_proposals_returns_pending(client, db_session):
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    db_session.commit()
    _as(USER_1)

    resp = client.get(f"/api/v2/workspaces/{org.id}/proposals")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == action.id
    assert body[0]["status"] == "pending_approval"
    assert body[0]["approved_payload_hash"] is None


def test_list_proposals_filter_by_status(client, db_session):
    org = _seed(db_session)
    _make_action(db_session, org.id)
    db_session.commit()
    _as(USER_1)

    resp = client.get(f"/api/v2/workspaces/{org.id}/proposals?status=approved")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_proposals_invalid_status_422(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_1)

    resp = client.get(f"/api/v2/workspaces/{org.id}/proposals?status=nope")
    assert resp.status_code == 422


def test_list_proposals_project_scope_non_member_404(client, db_session):
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    project = _project_with_meeting(db_session, org.id, USER_1, action)
    db_session.commit()
    _as(USER_2, "other@example.com")

    resp = client.get(f"/api/v2/workspaces/{org.id}/proposals?project_id={project.id}")
    assert resp.status_code == 404


def test_list_proposals_project_scope_member_sees_actions(client, db_session):
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    project = _project_with_meeting(db_session, org.id, USER_1, action)
    db_session.commit()
    _as(USER_1)

    resp = client.get(f"/api/v2/workspaces/{org.id}/proposals?project_id={project.id}")
    assert resp.status_code == 200
    assert len(resp.json()) == 1
    assert resp.json()[0]["id"] == action.id


# ---------------------------------------------------------------------------
# Approve
# ---------------------------------------------------------------------------


def test_approve_correct_hash(client, db_session):
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    db_session.commit()
    _as(USER_1)

    expected = _hash(_PAYLOAD)
    resp = client.post(
        f"/api/v2/workspaces/{org.id}/proposals/{action.id}/approve",
        json={"payload_hash": expected},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "approved"
    assert body["approved_payload_hash"] == expected
    db_session.refresh(action)
    actor = db_session.get(Person, action.approved_by_person_id)
    assert actor.org_id == org.id
    assert actor.user_id == USER_1
    assert action.approved_at is not None


@pytest.mark.parametrize("status", [ActionStatus.APPROVED, ActionStatus.EXECUTED])
@pytest.mark.parametrize("missing", ["actor", "timestamp"])
def test_database_blocks_orm_status_without_complete_approval(db_session, status, missing):
    """SQLAlchemy stores enum names (uppercase), not the lowercase API values."""
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    actor = Person(org_id=org.id, user_id=USER_1, display_name="Founder")
    db_session.add(actor)
    db_session.flush()
    action.status = status
    action.approved_by_person_id = actor.id if missing != "actor" else None
    action.approved_at = datetime.now(UTC) if missing != "timestamp" else None
    with pytest.raises(IntegrityError, match="ck_action_requires_approval"):
        db_session.flush()
    db_session.rollback()


def test_approve_wrong_hash_409(client, db_session):
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    db_session.commit()
    _as(USER_1)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/proposals/{action.id}/approve",
        json={"payload_hash": "deadbeef" * 8},
    )
    assert resp.status_code == 409
    assert "payload_hash" in resp.json()["detail"]


def test_approve_idempotent_same_hash(client, db_session):
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    db_session.commit()
    _as(USER_1)

    expected = _hash(_PAYLOAD)
    client.post(
        f"/api/v2/workspaces/{org.id}/proposals/{action.id}/approve",
        json={"payload_hash": expected},
    )
    resp2 = client.post(
        f"/api/v2/workspaces/{org.id}/proposals/{action.id}/approve",
        json={"payload_hash": expected},
    )
    assert resp2.status_code == 200
    assert resp2.json()["status"] == "approved"


def test_approve_unknown_proposal_404(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_1)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/proposals/no-such-id/approve",
        json={"payload_hash": "a" * 64},
    )
    assert resp.status_code == 404


def test_approve_rejected_proposal_409(client, db_session):
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    db_session.commit()
    _as(USER_1)

    client.post(f"/api/v2/workspaces/{org.id}/proposals/{action.id}/reject")

    expected = _hash(_PAYLOAD)
    resp = client.post(
        f"/api/v2/workspaces/{org.id}/proposals/{action.id}/approve",
        json={"payload_hash": expected},
    )
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Reject
# ---------------------------------------------------------------------------


def test_reject_pending(client, db_session):
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    db_session.commit()
    _as(USER_1)

    resp = client.post(f"/api/v2/workspaces/{org.id}/proposals/{action.id}/reject")
    assert resp.status_code == 204


def test_reject_idempotent(client, db_session):
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    db_session.commit()
    _as(USER_1)

    client.post(f"/api/v2/workspaces/{org.id}/proposals/{action.id}/reject")
    resp2 = client.post(f"/api/v2/workspaces/{org.id}/proposals/{action.id}/reject")
    assert resp2.status_code == 204


def test_reject_approved_409(client, db_session):
    org = _seed(db_session)
    action = _make_action(db_session, org.id)
    db_session.commit()
    _as(USER_1)

    # Approve first
    client.post(
        f"/api/v2/workspaces/{org.id}/proposals/{action.id}/approve",
        json={"payload_hash": _hash(_PAYLOAD)},
    )

    # Rejecting an approved action is not allowed
    resp = client.post(f"/api/v2/workspaces/{org.id}/proposals/{action.id}/reject")
    assert resp.status_code == 409


def test_reject_unknown_404(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_1)

    resp = client.post(f"/api/v2/workspaces/{org.id}/proposals/no-such-id/reject")
    assert resp.status_code == 404
