from app.api.capture_v2 import get_capture_secret_store
from app.db.models import CaptureRequest, Meeting, Org, OrgMember, OutboxEvent, User
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
    org = Org(name="Acme")
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
