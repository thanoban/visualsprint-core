"""Generic OAuth2 authorization-code flow (app/oauth/flow.py) -- state
signing/verification and token exchange/refresh against a mocked httpx
transport. No real vendor credentials needed."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.oauth.flow import (
    OAuthStateError,
    OAuthTokenExchangeError,
    build_authorize_url,
    exchange_code_for_token,
    refresh_access_token,
    sign_state,
    verify_state,
)
from app.oauth.providers import OAuthProviderConfig

CONFIG = OAuthProviderConfig(
    provider="testvendor",
    client_id="client-123",
    client_secret="secret-456",
    authorize_url="https://vendor.test/oauth/authorize",
    token_url="https://vendor.test/oauth/token",
    scope="read write",
    extra_authorize_params={"access_type": "offline"},
)


def _client_with(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_build_authorize_url_includes_all_required_params():
    url = build_authorize_url(CONFIG, state="abc.def", redirect_uri="https://api.test/callback")

    assert url.startswith("https://vendor.test/oauth/authorize?")
    assert "client_id=client-123" in url
    assert "state=abc.def" in url
    assert "scope=read+write" in url
    assert "access_type=offline" in url
    assert "redirect_uri=https%3A%2F%2Fapi.test%2Fcallback" in url


def test_sign_then_verify_state_roundtrips_the_org_id():
    state = sign_state(org_id="org-1", provider="google", secret="shh")

    org_id = verify_state(state, provider="google", secret="shh")

    assert org_id == "org-1"


def test_verify_state_rejects_a_tampered_signature():
    state = sign_state(org_id="org-1", provider="google", secret="shh")
    payload_b64, _sig = state.split(".", 1)
    forged = f"{payload_b64}.0000000000000000000000000000000000000000000000000000000000000000"

    with pytest.raises(OAuthStateError, match="signature mismatch"):
        verify_state(forged, provider="google", secret="shh")


def test_verify_state_rejects_the_wrong_secret():
    state = sign_state(org_id="org-1", provider="google", secret="shh")

    with pytest.raises(OAuthStateError, match="signature mismatch"):
        verify_state(state, provider="google", secret="different-secret")


def test_verify_state_rejects_a_provider_mismatch():
    """A state signed for 'google' must not be usable against the 'slack'
    callback -- otherwise a state param meant for one vendor's flow could
    be replayed against another's."""
    state = sign_state(org_id="org-1", provider="google", secret="shh")

    with pytest.raises(OAuthStateError, match="issued for provider 'google'"):
        verify_state(state, provider="slack", secret="shh")


def test_verify_state_rejects_an_expired_state():
    long_ago = datetime.now(UTC) - timedelta(hours=1)
    state = sign_state(org_id="org-1", provider="google", secret="shh", now=long_ago)

    with pytest.raises(OAuthStateError, match="expired"):
        verify_state(state, provider="google", secret="shh")


def test_verify_state_rejects_malformed_input():
    with pytest.raises(OAuthStateError, match="malformed"):
        verify_state("not-a-valid-state-at-all", provider="google", secret="shh")


async def test_exchange_code_parses_access_and_refresh_tokens():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://vendor.test/oauth/token")
        body = request.read().decode()
        assert "grant_type=authorization_code" in body
        assert "code=auth-code-1" in body
        return httpx.Response(
            200,
            json={"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600},
        )

    token_set = await exchange_code_for_token(
        CONFIG,
        code="auth-code-1",
        redirect_uri="https://api.test/callback",
        http_client=_client_with(handler),
    )

    assert token_set.access_token == "at-1"
    assert token_set.refresh_token == "rt-1"
    assert token_set.expires_at is not None
    assert token_set.expires_at > datetime.now(UTC)


async def test_exchange_code_handles_a_token_that_never_expires():
    """GitHub's classic OAuth apps omit expires_in entirely."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "at-1"})

    token_set = await exchange_code_for_token(
        CONFIG, code="c", redirect_uri="https://api.test/callback", http_client=_client_with(handler)
    )

    assert token_set.access_token == "at-1"
    assert token_set.refresh_token is None
    assert token_set.expires_at is None


async def test_exchange_code_surfaces_a_vendor_error_response():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_grant"})

    with pytest.raises(httpx.HTTPStatusError):
        await exchange_code_for_token(
            CONFIG, code="bad", redirect_uri="https://api.test/callback",
            http_client=_client_with(handler),
        )


async def test_refresh_preserves_the_original_refresh_token_when_the_response_omits_one():
    """Several vendors (Google included) don't repeat refresh_token on a
    refresh response -- the original must be preserved, not dropped."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read().decode()
        assert "grant_type=refresh_token" in body
        assert "refresh_token=rt-original" in body
        return httpx.Response(200, json={"access_token": "at-2", "expires_in": 3600})

    token_set = await refresh_access_token(
        CONFIG, refresh_token="rt-original", http_client=_client_with(handler)
    )

    assert token_set.access_token == "at-2"
    assert token_set.refresh_token == "rt-original"


async def test_refresh_uses_a_new_refresh_token_when_the_vendor_rotates_it():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"access_token": "at-2", "refresh_token": "rt-rotated", "expires_in": 3600}
        )

    token_set = await refresh_access_token(
        CONFIG, refresh_token="rt-original", http_client=_client_with(handler)
    )

    assert token_set.refresh_token == "rt-rotated"


async def test_exchange_code_raises_on_slacks_body_level_ok_false():
    """Slack's oauth.v2.access returns HTTP 200 even on failure --
    raise_for_status() alone would miss this entirely."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": False, "error": "invalid_code"})

    with pytest.raises(OAuthTokenExchangeError, match="invalid_code"):
        await exchange_code_for_token(
            CONFIG, code="bad", redirect_uri="https://api.test/callback",
            http_client=_client_with(handler),
        )


async def test_exchange_code_preserves_the_full_response_body_in_extra():
    """Slack's token response carries team.name/team.id directly -- no
    separate userinfo call exists the way Google/GitHub have one, so a
    callback needs the raw body, not just access_token/refresh_token."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "ok": True,
                "access_token": "xoxb-1",
                "team": {"id": "T123", "name": "Acme Workspace"},
            },
        )

    token_set = await exchange_code_for_token(
        CONFIG, code="c", redirect_uri="https://api.test/callback", http_client=_client_with(handler)
    )

    assert token_set.extra["team"]["name"] == "Acme Workspace"
