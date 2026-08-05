"""OAuthTokenProvider -- resolves/refreshes a real OAuth grant's access
token via SecretStore + app/oauth/flow.py. Fake SecretStore and mocked
httpx transport, no real vendor credentials needed."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.capture.oauth_token_provider import OAuthTokenProvider
from app.oauth.flow import OAuthTokenSet
from app.oauth.providers import OAuthProviderConfig

CONFIG = OAuthProviderConfig(
    provider="testvendor",
    client_id="cid",
    client_secret="csecret",
    authorize_url="https://vendor.test/authorize",
    token_url="https://vendor.test/token",
    scope="read",
)


class FakeSecretStore:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def put(self, name: str, value: str) -> None:
        self.values[name] = value

    async def get(self, name: str) -> str:
        if name not in self.values:
            raise KeyError(name)
        return self.values[name]

    async def delete(self, name: str) -> None:
        self.values.pop(name, None)


def _client_with(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def _seed(store: FakeSecretStore, ref: str, token_set: OAuthTokenSet) -> None:
    await store.put(ref, token_set.model_dump_json())


async def test_returns_the_cached_token_when_not_expired():
    store = FakeSecretStore()
    await _seed(
        store,
        "conn-1",
        OAuthTokenSet(access_token="at-valid", expires_at=datetime.now(UTC) + timedelta(hours=1)),
    )
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={"access_token": "should-not-be-used"})

    provider = OAuthTokenProvider(
        secret_ref="conn-1", provider_config=CONFIG, secret_store=store,
        http_client=_client_with(handler),
    )

    token = await provider.get_token()

    assert token == "at-valid"
    assert called is False


async def test_a_token_with_no_expiry_is_never_refreshed():
    """GitHub classic OAuth tokens have no expires_at at all."""
    store = FakeSecretStore()
    await _seed(store, "conn-1", OAuthTokenSet(access_token="at-forever", expires_at=None))
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={"access_token": "x"})

    provider = OAuthTokenProvider(
        secret_ref="conn-1", provider_config=CONFIG, secret_store=store,
        http_client=_client_with(handler),
    )

    token = await provider.get_token()

    assert token == "at-forever"
    assert called is False


async def test_refreshes_and_persists_an_expired_token():
    store = FakeSecretStore()
    await _seed(
        store,
        "conn-1",
        OAuthTokenSet(
            access_token="at-expired",
            refresh_token="rt-1",
            expires_at=datetime.now(UTC) - timedelta(minutes=5),
        ),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert "refresh_token=rt-1" in request.read().decode()
        return httpx.Response(
            200, json={"access_token": "at-refreshed", "refresh_token": "rt-1", "expires_in": 3600}
        )

    provider = OAuthTokenProvider(
        secret_ref="conn-1", provider_config=CONFIG, secret_store=store,
        http_client=_client_with(handler),
    )

    token = await provider.get_token()

    assert token == "at-refreshed"
    persisted = OAuthTokenSet.model_validate_json(store.values["conn-1"])
    assert persisted.access_token == "at-refreshed"


async def test_a_token_expiring_within_the_buffer_window_is_treated_as_expired():
    store = FakeSecretStore()
    await _seed(
        store,
        "conn-1",
        OAuthTokenSet(
            access_token="at-almost-gone",
            refresh_token="rt-1",
            expires_at=datetime.now(UTC) + timedelta(seconds=30),  # inside the 60s buffer
        ),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "at-refreshed", "expires_in": 3600})

    provider = OAuthTokenProvider(
        secret_ref="conn-1", provider_config=CONFIG, secret_store=store,
        http_client=_client_with(handler),
    )

    token = await provider.get_token()

    assert token == "at-refreshed"


async def test_raises_a_clear_error_when_expired_with_no_refresh_token():
    store = FakeSecretStore()
    await _seed(
        store,
        "conn-1",
        OAuthTokenSet(
            access_token="at-dead", refresh_token=None, expires_at=datetime.now(UTC) - timedelta(hours=1)
        ),
    )

    provider = OAuthTokenProvider(
        secret_ref="conn-1", provider_config=CONFIG, secret_store=store,
        http_client=_client_with(lambda r: httpx.Response(200, json={})),
    )

    with pytest.raises(RuntimeError, match="needs to be re-authorized"):
        await provider.get_token()


async def test_missing_connection_raises_keyerror():
    store = FakeSecretStore()
    provider = OAuthTokenProvider(
        secret_ref="never-connected", provider_config=CONFIG, secret_store=store,
        http_client=_client_with(lambda r: httpx.Response(200, json={})),
    )

    with pytest.raises(KeyError):
        await provider.get_token()
