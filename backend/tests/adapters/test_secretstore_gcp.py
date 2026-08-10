"""GcpSecretStore against a fake Secret Manager-shaped client -- no real
google-cloud-secret-manager import needed to run these (same pattern as
S3BlobStore's fake botocore client: the lazy import only fires if no
client is injected)."""

import pytest

from app.adapters.secretstore_gcp import GcpSecretStore


class FakeNotFound(Exception):
    pass


class FakeAlreadyExists(Exception):
    pass


class _Payload:
    def __init__(self, data: bytes) -> None:
        self.data = data


class _AccessResponse:
    def __init__(self, data: bytes) -> None:
        self.payload = _Payload(data)


class FakeSecretManagerClient:
    def __init__(self) -> None:
        self.secrets: set[str] = set()
        self.versions: dict[str, list[bytes]] = {}
        self.create_calls: list[dict] = []

    def create_secret(self, request: dict):
        secret_id = request["secret_id"]
        path = f"{request['parent']}/secrets/{secret_id}"
        self.create_calls.append(request)
        if path in self.secrets:
            raise FakeAlreadyExists(f"Secret [{path}] already exists")
        self.secrets.add(path)
        self.versions[path] = []

    def add_secret_version(self, request: dict):
        path = request["parent"]
        if path not in self.secrets:
            raise FakeNotFound(f"Secret [{path}] not found")
        self.versions[path].append(request["payload"]["data"])

    def access_secret_version(self, request: dict):
        name = request["name"]
        path = name.rsplit("/versions/", 1)[0]
        if path not in self.secrets or not self.versions.get(path):
            raise FakeNotFound(f"Secret [{path}] not found")
        return _AccessResponse(self.versions[path][-1])

    def delete_secret(self, request: dict):
        path = request["name"]
        if path not in self.secrets:
            raise FakeNotFound(f"Secret [{path}] not found")
        self.secrets.discard(path)
        self.versions.pop(path, None)


@pytest.fixture
def client() -> FakeSecretManagerClient:
    return FakeSecretManagerClient()


@pytest.fixture
def store(client: FakeSecretManagerClient) -> GcpSecretStore:
    return GcpSecretStore(client=client, project_id="test-project")


async def test_put_then_get_roundtrips_the_value(store: GcpSecretStore):
    await store.put("oauth/google/conn1", '{"access_token": "abc"}')

    assert await store.get("oauth/google/conn1") == '{"access_token": "abc"}'


async def test_put_creates_the_secret_only_once_across_repeated_writes(
    store: GcpSecretStore, client: FakeSecretManagerClient
):
    await store.put("oauth/google/conn1", "v1")
    await store.put("oauth/google/conn1", "v2")

    assert len(client.create_calls) == 2  # create_secret is attempted each time...
    assert len(client.secrets) == 1  # ...but AlreadyExists is swallowed, so only one secret exists
    assert await store.get("oauth/google/conn1") == "v2"  # latest version wins


async def test_get_raises_keyerror_for_a_secret_that_was_never_created(store: GcpSecretStore):
    with pytest.raises(KeyError, match="not found"):
        await store.get("never-stored")


async def test_delete_is_idempotent_on_an_already_missing_secret(store: GcpSecretStore):
    await store.delete("never-stored")  # must not raise


async def test_delete_removes_the_secret_so_get_then_raises(store: GcpSecretStore):
    await store.put("oauth/slack/conn1", "value")
    await store.delete("oauth/slack/conn1")

    with pytest.raises(KeyError):
        await store.get("oauth/slack/conn1")


async def test_names_with_slashes_are_sanitized_into_a_valid_secret_id(
    store: GcpSecretStore, client: FakeSecretManagerClient
):
    await store.put("oauth/google/conn-abc", "value")

    (call,) = client.create_calls
    assert "/" not in call["secret_id"]
    assert await store.get("oauth/google/conn-abc") == "value"


async def test_requires_a_project_id_when_none_configured(monkeypatch):
    monkeypatch.setattr("google.auth.default", lambda: (None, None))

    from app.config import get_settings

    get_settings.cache_clear()
    # delenv alone doesn't shadow a value backend/.env supplies directly --
    # pydantic-settings falls back to reading the file when the var isn't
    # in os.environ. "" is a real env var that wins over the file, and is
    # falsy so the adapter still treats it as "not configured".
    monkeypatch.setenv("VS_VERTEX_PROJECT_ID", "")
    try:
        with pytest.raises(RuntimeError, match="vertex_project_id"):
            GcpSecretStore(client=object())
    finally:
        get_settings.cache_clear()
