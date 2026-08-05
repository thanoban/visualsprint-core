"""Tests for the action-approval UI backend (app/api/actions.py).

Covers: listing an org's proposed actions (optionally filtered by status),
approving (which must both record the approval and attempt execution,
succeeding or failing visibly rather than silently), rejecting, and the
state-machine guards (can't approve/reject twice, can't approve straight
into EXECUTED without a connector attempt).
"""

from app.db.models import (
    ActionStatus,
    AuditLog,
    CaptureSession,
    Meeting,
    Org,
    Person,
    ProposedAction,
)


def _seed(db, *, kind: str = "email_draft", target: dict | None = None):
    org = Org(name="acme")
    db.add(org)
    db.flush()

    person = Person(org_id=org.id, display_name="Nimal Perera")
    db.add(person)
    db.flush()

    meeting = Meeting(org_id=org.id, title="Infra Sync", platform="upload")
    db.add(meeting)
    db.flush()

    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()

    action = ProposedAction(
        org_id=org.id,
        capture_session_id=session.id,
        kind=kind,
        payload={
            "title": "Follow up on migration",
            "body": "Please confirm the Postgres migration timeline.",
            "target": target or {},
            "evidence_item_ids": [],
        },
    )
    db.add(action)
    db.commit()
    return org.id, action.id, person.id


def test_list_actions_returns_pending_by_default(client, db_session):
    org_id, action_id, _person_id = _seed(db_session)

    resp = client.get(f"/api/v1/orgs/{org_id}/actions")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["id"] == action_id
    assert rows[0]["status"] == "pending_approval"
    assert rows[0]["title"] == "Follow up on migration"


def test_list_actions_filters_by_status(db_session, client):
    org_id, _action_id, _person_id = _seed(db_session)

    resp = client.get(f"/api/v1/orgs/{org_id}/actions?status=executed")
    assert resp.status_code == 200
    assert resp.json() == []

    resp2 = client.get(f"/api/v1/orgs/{org_id}/actions?status=not-a-real-status")
    assert resp2.status_code == 400


def test_list_actions_404_for_unknown_org(client):
    resp = client.get("/api/v1/orgs/does-not-exist/actions")
    assert resp.status_code == 404


def test_approve_records_approval_even_when_execution_fails(client, db_session):
    """No connector has real credentials configured (UnconfiguredTokenProvider
    everywhere, matching every other vendor integration in this codebase) --
    approval must still be recorded, and the execution failure must be
    visible rather than silently swallowed."""
    org_id, action_id, person_id = _seed(
        db_session, kind="email_draft", target={"to": "team@example.com"}
    )

    resp = client.post(
        f"/api/v1/actions/{action_id}/approve", json={"approved_by_person_id": person_id}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "failed"
    assert body["approved_by"] == "Nimal Perera"
    assert body["approved_at"] is not None
    assert "not configured" in body["error"]

    row = db_session.get(ProposedAction, action_id)
    assert row.status == ActionStatus.FAILED
    assert row.approved_by_person_id == person_id
    assert row.approved_at is not None


def test_approve_can_be_retried_after_failure(client, db_session):
    org_id, action_id, person_id = _seed(db_session)
    first = client.post(f"/api/v1/actions/{action_id}/approve", json={})
    assert first.json()["status"] == "failed"

    second = client.post(f"/api/v1/actions/{action_id}/approve", json={})
    assert second.status_code == 200
    assert second.json()["status"] == "failed"  # still no credentials, still fails cleanly


def test_approve_escalation_records_approval_and_a_clear_error(client, db_session):
    """EscalationConnector delegates to ChannelRecapConnector -- with no
    target provider set (the seed default), it fails with that connector's
    own clear error, not a generic 'unconfigured' one."""
    org_id, action_id, person_id = _seed(db_session, kind="escalation")

    resp = client.post(f"/api/v1/actions/{action_id}/approve", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "failed"
    assert "unsupported channel_recap provider" in body["error"]
    assert body["approved_at"] is not None


def test_approve_reminder_records_approval_and_a_clear_error(client, db_session):
    """ReminderConnector delegates to EmailDraftConnector -- with no target
    'to' set (the seed default), it fails with that connector's own clear
    error."""
    org_id, action_id, person_id = _seed(db_session, kind="reminder")

    resp = client.post(f"/api/v1/actions/{action_id}/approve", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "failed"
    assert "email_draft target requires 'to'" in body["error"]
    assert body["approved_at"] is not None


def test_approve_404_for_unknown_action(client):
    resp = client.post("/api/v1/actions/does-not-exist/approve", json={})
    assert resp.status_code == 404


def test_approve_rejects_already_approved_action(client, db_session):
    org_id, action_id, _person_id = _seed(db_session)
    action = db_session.get(ProposedAction, action_id)
    action.status = ActionStatus.EXECUTED
    db_session.commit()

    resp = client.post(f"/api/v1/actions/{action_id}/approve", json={})
    assert resp.status_code == 409


def test_reject_sets_status(client, db_session):
    org_id, action_id, _person_id = _seed(db_session)

    resp = client.post(f"/api/v1/actions/{action_id}/reject")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "rejected"

    row = db_session.get(ProposedAction, action_id)
    assert row.status == ActionStatus.REJECTED


def test_reject_404_for_unknown_action(client):
    resp = client.post("/api/v1/actions/does-not-exist/reject")
    assert resp.status_code == 404


def test_reject_rejects_non_pending_action(client, db_session):
    org_id, action_id, _person_id = _seed(db_session)
    action = db_session.get(ProposedAction, action_id)
    action.status = ActionStatus.REJECTED
    db_session.commit()

    resp = client.post(f"/api/v1/actions/{action_id}/reject")
    assert resp.status_code == 409


def test_approve_writes_an_audit_log_entry(client, db_session):
    org_id, action_id, person_id = _seed(db_session)

    client.post(f"/api/v1/actions/{action_id}/approve", json={"approved_by_person_id": person_id})

    entries = db_session.query(AuditLog).filter(AuditLog.org_id == org_id).all()
    assert len(entries) == 1
    assert entries[0].event == "action_approved"
    assert entries[0].actor == person_id
    assert entries[0].detail == {"action_id": action_id, "kind": "email_draft"}


def test_approve_without_a_person_id_attributes_to_system(client, db_session):
    org_id, action_id, _person_id = _seed(db_session)

    client.post(f"/api/v1/actions/{action_id}/approve", json={})

    entry = db_session.query(AuditLog).filter(AuditLog.org_id == org_id).one()
    assert entry.actor == "system"


def test_approve_and_reject_never_leak_the_action_title_into_the_audit_trail(client, db_session):
    """Regression: approve/reject used to log payload['title'] into
    AuditLog.detail -- since AuditLog has no FK back to the ProposedAction
    (or the meeting/knowledge item the title was drawn from) for a later
    erasure to find and scrub, that copy would silently outlive any purge
    or deletion of the source content."""
    org_id, action_id, _person_id = _seed(db_session)

    client.post(f"/api/v1/actions/{action_id}/approve", json={})

    org_id2, action_id2, _ = _seed(db_session)
    client.post(f"/api/v1/actions/{action_id2}/reject")

    entries = (
        db_session.query(AuditLog).filter(AuditLog.org_id.in_([org_id, org_id2])).all()
    )
    assert len(entries) == 2
    for entry in entries:
        assert "title" not in entry.detail
        assert "Follow up on migration" not in str(entry.detail)


def test_reject_writes_an_audit_log_entry_attributed_to_the_rejector(client, db_session):
    org_id, action_id, person_id = _seed(db_session)

    client.post(f"/api/v1/actions/{action_id}/reject", json={"rejected_by_person_id": person_id})

    entry = db_session.query(AuditLog).filter(AuditLog.org_id == org_id).one()
    assert entry.event == "action_rejected"
    assert entry.actor == person_id
    assert entry.detail == {"action_id": action_id, "kind": "email_draft"}


def test_reject_with_no_body_still_works_and_attributes_to_system(client, db_session):
    org_id, action_id, _person_id = _seed(db_session)

    resp = client.post(f"/api/v1/actions/{action_id}/reject")

    assert resp.status_code == 200, resp.text
    entry = db_session.query(AuditLog).filter(AuditLog.org_id == org_id).one()
    assert entry.actor == "system"
