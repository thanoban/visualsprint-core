"""LocalSecretStore -- dev-mode SecretStore Protocol implementation."""

import pytest

from app.adapters.secretstore_local import LocalSecretStore


@pytest.fixture
def store(tmp_path) -> LocalSecretStore:
    return LocalSecretStore(root=str(tmp_path))


async def test_put_then_get_roundtrips_the_value(store: LocalSecretStore):
    await store.put("oauth/google/conn1", '{"access_token": "abc"}')

    assert await store.get("oauth/google/conn1") == '{"access_token": "abc"}'


async def test_put_overwrites_an_existing_secret(store: LocalSecretStore):
    await store.put("oauth/google/conn1", "old-value")
    await store.put("oauth/google/conn1", "new-value")

    assert await store.get("oauth/google/conn1") == "new-value"


async def test_get_raises_keyerror_for_a_missing_secret(store: LocalSecretStore):
    with pytest.raises(KeyError, match="not found"):
        await store.get("never-stored")


async def test_delete_is_idempotent_on_an_already_missing_secret(store: LocalSecretStore):
    await store.delete("never-stored")  # must not raise


async def test_delete_removes_a_secret_so_get_then_raises(store: LocalSecretStore):
    await store.put("oauth/slack/conn1", "value")
    await store.delete("oauth/slack/conn1")

    with pytest.raises(KeyError):
        await store.get("oauth/slack/conn1")


async def test_rejects_path_escape(store: LocalSecretStore):
    with pytest.raises(ValueError, match="invalid secret name"):
        await store.get("../../etc/passwd")


async def test_rejects_empty_name(store: LocalSecretStore):
    with pytest.raises(ValueError, match="invalid secret name"):
        await store.put("", "value")


async def test_names_with_slashes_create_nested_directories(store: LocalSecretStore):
    # OAuthTokenProvider names secrets like "oauth/google/<connection-id>" --
    # this must round-trip cleanly, not just work by accident of a flat name.
    await store.put("oauth/google/conn-abc", "value")

    assert await store.get("oauth/google/conn-abc") == "value"
