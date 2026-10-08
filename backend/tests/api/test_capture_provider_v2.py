from app.api.capture_v2 import get_capture_secret_store
from app.db.models import Org, OrgMember, ProviderBinding, User
from app.main import app

USER_ID = "11111111-1111-1111-1111-111111111111"


class MemorySecrets:
    def __init__(self):
        self.values = {}

    async def put(self, name, value):
        self.values[name] = value

    async def get(self, name):
        return self.values[name]

    async def delete(self, name):
        self.values.pop(name, None)


def seed(db, role="owner"):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    db.add(User(id=USER_ID, email="test@example.com"))
    db.flush()
    db.add(OrgMember(org_id=org.id, user_id=USER_ID, role=role))
    db.commit()
    return org


def configure(client, org_id, **changes):
    body = {
        "endpoint_url": "https://vexa.example",
        "api_key": "private-key",
        "account_scope_id": "vexa-account-1",
    }
    body.update(changes)
    return client.put(f"/api/v2/workspaces/{org_id}/capture-provider/vexa", json=body)


def test_owner_configures_provider_without_exposing_credentials(client, db_session):
    org = seed(db_session)
    secrets = MemorySecrets()
    app.dependency_overrides[get_capture_secret_store] = lambda: secrets

    response = configure(client, org.id)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "id": response.json()["id"],
        "provider": "vexa",
        "account_scope_id": "vexa-account-1",
        "status": "active",
    }
    assert "private-key" not in response.text
    binding = db_session.query(ProviderBinding).one()
    assert secrets.values[binding.endpoint_ref] == "https://vexa.example"
    assert secrets.values[binding.secret_ref] == "private-key"
    get_response = client.get(f"/api/v2/workspaces/{org.id}/capture-provider")
    assert get_response.status_code == 200
    assert "secret" not in get_response.text.lower()


def test_regular_member_cannot_configure_provider_or_write_secrets(client, db_session):
    org = seed(db_session, role="member")
    secrets = MemorySecrets()
    app.dependency_overrides[get_capture_secret_store] = lambda: secrets

    response = configure(client, org.id)

    assert response.status_code == 403
    assert secrets.values == {}
    assert db_session.query(ProviderBinding).count() == 0


def test_provider_account_scope_cannot_be_shared_across_workspaces(client, db_session):
    org = seed(db_session)
    other = Org(name="Other")
    db_session.add(other)
    db_session.flush()
    db_session.add(
        ProviderBinding(
            org_id=other.id,
            provider="vexa",
            endpoint_ref="other-endpoint",
            account_scope_id="vexa-account-1",
            secret_ref="other-key",
        )
    )
    db_session.commit()
    secrets = MemorySecrets()
    app.dependency_overrides[get_capture_secret_store] = lambda: secrets

    response = configure(client, org.id)

    assert response.status_code == 409
    assert secrets.values == {}


def test_remote_http_or_credentialed_endpoint_is_rejected_before_secret_write(client, db_session):
    org = seed(db_session)
    secrets = MemorySecrets()
    app.dependency_overrides[get_capture_secret_store] = lambda: secrets

    assert configure(client, org.id, endpoint_url="http://vexa.example").status_code == 422
    assert (
        configure(client, org.id, endpoint_url="https://user:password@vexa.example").status_code
        == 422
    )
    assert secrets.values == {}
