from datetime import UTC, datetime, timedelta

from app.api.capture_v2 import get_capture_secret_store
from app.db.models import (
    CaptureAttempt,
    CaptureAttemptState,
    CaptureRequest,
    CaptureRequestStatus,
    Meeting,
    Org,
    OrgMember,
    OutboxEvent,
    OutboxStatus,
    ProviderBinding,
    User,
)
from app.main import app

USER_ID = "test-user-0000-0000-0000-000000000000"


class MemorySecrets:
    def __init__(self):
        self.values = {}
        self.puts = 0
        self.deletes = []

    async def put(self, name, value):
        self.puts += 1
        self.values[name] = value

    async def get(self, name):
        return self.values[name]

    async def delete(self, name):
        self.deletes.append(name)
        self.values.pop(name, None)


def seed(db):
    org = Org(
        name="Acme",
        capture_policy="manual",
        disclosure_ack_at=datetime(2026, 10, 8, tzinfo=UTC),
    )
    db.add(org)
    db.flush()
    db.add(User(id=USER_ID, email="test@example.com"))
    db.add(OrgMember(org_id=org.id, user_id=USER_ID, role="owner"))
    meeting = Meeting(org_id=org.id, title="Customer call", platform="meet")
    db.add(meeting)
    db.commit()
    return org, meeting


def payload(meeting_id, **changes):
    value = {
        "meeting_id": meeting_id,
        "meeting_url": "https://meet.google.com/abc-defg-hij?authuser=1",
        "estimated_seconds": 1800,
        "policy": {"capture": True, "language": "en"},
    }
    value.update(changes)
    return value


def install_secrets(secrets):
    app.dependency_overrides[get_capture_secret_store] = lambda: secrets


def test_create_is_accepted_and_never_returns_or_persists_meeting_url(client, db_session):
    org, meeting = seed(db_session)
    secrets = MemorySecrets()
    install_secrets(secrets)

    response = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "browser-request-1"},
        json=payload(meeting.id),
    )

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["created"] is True
    assert body["status"] == "queued"
    assert "meeting_url" not in body
    request = db_session.get(CaptureRequest, body["id"])
    assert request is not None
    assert "meet.google.com" not in repr(request.__dict__)
    assert secrets.values[request.meeting_url_secret_ref].startswith("https://meet.google.com/")
    assert db_session.query(OutboxEvent).filter_by(operation="capture.dispatch").count() == 1


def test_same_idempotency_request_returns_existing_without_rewriting_secret(client, db_session):
    org, meeting = seed(db_session)
    secrets = MemorySecrets()
    install_secrets(secrets)
    url = f"/api/v2/workspaces/{org.id}/capture-requests"
    headers = {"Idempotency-Key": "browser-request-1"}

    first = client.post(url, headers=headers, json=payload(meeting.id))
    second = client.post(url, headers=headers, json=payload(meeting.id))

    assert first.status_code == 202
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["created"] is False
    assert secrets.puts == 1
    assert db_session.query(CaptureRequest).count() == 1


def test_same_key_with_different_payload_is_409_without_secret_write(client, db_session):
    org, meeting = seed(db_session)
    secrets = MemorySecrets()
    install_secrets(secrets)
    url = f"/api/v2/workspaces/{org.id}/capture-requests"
    headers = {"Idempotency-Key": "browser-request-1"}
    assert client.post(url, headers=headers, json=payload(meeting.id)).status_code == 202

    response = client.post(
        url,
        headers=headers,
        json=payload(meeting.id, estimated_seconds=900),
    )

    assert response.status_code == 409
    assert secrets.puts == 1
    assert db_session.query(CaptureRequest).count() == 1


def test_meeting_from_another_workspace_is_hidden_and_secret_is_cleaned(client, db_session):
    org, _ = seed(db_session)
    other = Org(name="Other")
    db_session.add(other)
    db_session.flush()
    meeting = Meeting(org_id=other.id, title="Private", platform="meet")
    db_session.add(meeting)
    db_session.commit()
    secrets = MemorySecrets()
    install_secrets(secrets)

    response = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "wrong-scope"},
        json=payload(meeting.id),
    )

    assert response.status_code == 404
    assert secrets.values == {}
    assert len(secrets.deletes) == 1


def test_get_is_scoped_to_workspace(client, db_session):
    org, meeting = seed(db_session)
    secrets = MemorySecrets()
    install_secrets(secrets)
    created = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "browser-request-1"},
        json=payload(meeting.id),
    ).json()

    assert client.get(
        f"/api/v2/workspaces/{org.id}/capture-requests/{created['id']}"
    ).status_code == 200
    assert client.get(
        f"/api/v2/workspaces/not-the-org/capture-requests/{created['id']}"
    ).status_code == 404


def test_capture_is_rejected_when_workspace_policy_is_off(client, db_session):
    org, meeting = seed(db_session)
    org.capture_policy = "off"
    db_session.commit()
    secrets = MemorySecrets()
    install_secrets(secrets)

    response = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "policy-off"},
        json=payload(meeting.id),
    )

    assert response.status_code == 409
    assert secrets.values == {}
    assert db_session.query(CaptureRequest).count() == 0


def test_stop_before_dispatch_cancels_intent_and_outbox(client, db_session):
    org, meeting = seed(db_session)
    install_secrets(MemorySecrets())
    created = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "cancel-me"},
        json=payload(meeting.id),
    ).json()

    response = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests/{created['id']}/stop"
    )

    assert response.status_code == 202
    assert response.json()["status"] == "cancelled"
    assert response.json()["stop_state"] == "confirmed"
    event = db_session.query(OutboxEvent).filter_by(operation="capture.dispatch").one()
    assert event.status == OutboxStatus.DONE


def test_stop_live_attempt_queues_reconciliation_and_status_exposes_freshness(client, db_session):
    org, meeting = seed(db_session)
    install_secrets(MemorySecrets())
    created = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "stop-live"},
        json=payload(meeting.id),
    ).json()
    request = db_session.get(CaptureRequest, created["id"])
    request.status = CaptureRequestStatus.MONITORING
    binding = ProviderBinding(
        org_id=org.id,
        provider="vexa",
        endpoint_ref="endpoint",
        account_scope_id="account-stop",
        secret_ref="key",
    )
    db_session.add(binding)
    db_session.flush()
    db_session.add(
        CaptureAttempt(
            org_id=org.id,
            request_id=request.id,
            attempt_no=1,
            provider_binding_id=binding.id,
            provider_record_id="record-live",
            state=CaptureAttemptState.CAPTURING,
            provider_status="active",
        )
    )
    db_session.commit()

    stopped = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests/{request.id}/stop"
    )
    repeated = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests/{request.id}/stop"
    )
    status_response = client.get(
        f"/api/v2/workspaces/{org.id}/capture-requests/{request.id}"
    )

    assert stopped.status_code == 202
    assert stopped.json()["stop_state"] == "requested"
    assert repeated.json()["stop_state"] == "requested"
    assert repeated.json()["version"] == stopped.json()["version"]
    assert status_response.json()["provider_state"] == "capturing"
    assert status_response.json()["provider_status"] == "active"
    assert db_session.query(OutboxEvent).filter_by(operation="capture.reconcile").count() == 1


def _add_live_attempt(db, org_id, request_id, *, state=CaptureAttemptState.CAPTURING,
                      last_contact_offset_seconds=0, last_transcript_offset_seconds=None):
    """Helper: add a CaptureAttempt in a live state with controlled timestamps."""
    binding = ProviderBinding(
        org_id=org_id,
        provider="vexa",
        endpoint_ref="ep",
        account_scope_id="scope",
        secret_ref="key",
    )
    db.add(binding)
    db.flush()
    now = datetime.now(UTC)
    contact_at = now - timedelta(seconds=last_contact_offset_seconds)
    transcript_at = None
    if last_transcript_offset_seconds is not None:
        transcript_at = now - timedelta(seconds=last_transcript_offset_seconds)
    attempt = CaptureAttempt(
        org_id=org_id,
        request_id=request_id,
        attempt_no=1,
        provider_binding_id=binding.id,
        provider_record_id="record-x",
        state=state,
        provider_status="active",
        last_provider_contact_at=contact_at,
        last_transcript_at=transcript_at,
    )
    db.add(attempt)
    db.commit()
    return attempt


def test_is_stale_false_when_contact_recent(client, db_session):
    org, meeting = seed(db_session)
    install_secrets(MemorySecrets())
    created = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "stale-recent"},
        json=payload(meeting.id),
    ).json()
    request = db_session.get(CaptureRequest, created["id"])
    request.status = CaptureRequestStatus.MONITORING
    db_session.flush()
    _add_live_attempt(db_session, org.id, request.id, last_contact_offset_seconds=30)

    resp = client.get(f"/api/v2/workspaces/{org.id}/capture-requests/{request.id}")
    assert resp.status_code == 200
    assert resp.json()["is_stale"] is False


def test_is_stale_true_when_contact_is_old(client, db_session):
    org, meeting = seed(db_session)
    install_secrets(MemorySecrets())
    created = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "stale-old"},
        json=payload(meeting.id),
    ).json()
    request = db_session.get(CaptureRequest, created["id"])
    request.status = CaptureRequestStatus.MONITORING
    db_session.flush()
    _add_live_attempt(db_session, org.id, request.id, last_contact_offset_seconds=300)

    resp = client.get(f"/api/v2/workspaces/{org.id}/capture-requests/{request.id}")
    assert resp.status_code == 200
    assert resp.json()["is_stale"] is True


def test_last_transcript_at_exposed_when_present(client, db_session):
    org, meeting = seed(db_session)
    install_secrets(MemorySecrets())
    created = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "transcript-freshness"},
        json=payload(meeting.id),
    ).json()
    request = db_session.get(CaptureRequest, created["id"])
    request.status = CaptureRequestStatus.MONITORING
    db_session.flush()
    _add_live_attempt(db_session, org.id, request.id,
                      last_contact_offset_seconds=10,
                      last_transcript_offset_seconds=20)

    resp = client.get(f"/api/v2/workspaces/{org.id}/capture-requests/{request.id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["last_transcript_at"] is not None
    assert body["is_stale"] is False


def test_last_transcript_at_none_when_no_transcript_yet(client, db_session):
    org, meeting = seed(db_session)
    install_secrets(MemorySecrets())
    created = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "no-transcript"},
        json=payload(meeting.id),
    ).json()
    request = db_session.get(CaptureRequest, created["id"])
    request.status = CaptureRequestStatus.MONITORING
    db_session.flush()
    _add_live_attempt(db_session, org.id, request.id, last_contact_offset_seconds=10)

    resp = client.get(f"/api/v2/workspaces/{org.id}/capture-requests/{request.id}")
    assert resp.status_code == 200
    assert resp.json()["last_transcript_at"] is None


def test_stale_flag_not_set_for_terminal_state(client, db_session):
    org, meeting = seed(db_session)
    install_secrets(MemorySecrets())
    created = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "terminal-stale"},
        json=payload(meeting.id),
    ).json()
    request = db_session.get(CaptureRequest, created["id"])
    request.status = CaptureRequestStatus.FINALIZED
    db_session.flush()
    _add_live_attempt(db_session, org.id, request.id,
                      state=CaptureAttemptState.ENDED,
                      last_contact_offset_seconds=600)

    resp = client.get(f"/api/v2/workspaces/{org.id}/capture-requests/{request.id}")
    assert resp.status_code == 200
    assert resp.json()["is_stale"] is False


def test_recurring_url_with_distinct_idempotency_keys_creates_separate_requests(client, db_session):
    """Same meeting URL (recurring Zoom) + different idempotency keys → separate requests."""
    org, meeting = seed(db_session)
    install_secrets(MemorySecrets())
    resp1 = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "occurrence-week-1"},
        json=payload(meeting.id),
    )
    resp2 = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "occurrence-week-2"},
        json=payload(meeting.id),
    )
    assert resp1.status_code == 202
    assert resp2.status_code == 202
    assert resp1.json()["id"] != resp2.json()["id"]


def test_out_of_order_stop_on_finalized_request_is_idempotent(client, db_session):
    """Stop on a FINALIZED request: stop_state confirmed, no new reconcile events."""
    org, meeting = seed(db_session)
    install_secrets(MemorySecrets())
    created = client.post(
        f"/api/v2/workspaces/{org.id}/capture-requests",
        headers={"Idempotency-Key": "overrun-stop"},
        json=payload(meeting.id),
    ).json()
    request = db_session.get(CaptureRequest, created["id"])
    request.status = CaptureRequestStatus.FINALIZED
    db_session.commit()

    resp = client.post(f"/api/v2/workspaces/{org.id}/capture-requests/{request.id}/stop")
    assert resp.status_code == 202
    assert resp.json()["stop_state"] == "confirmed"
    assert db_session.query(OutboxEvent).filter_by(operation="capture.reconcile").count() == 0
