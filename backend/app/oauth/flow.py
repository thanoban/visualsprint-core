"""Generic OAuth 2.0 authorization-code flow -- shared by every vendor
connection (Google, Slack, Jira, GitHub, Linear, Zoom's General App).
Vendor-specific quirks (scope string shape, extra required params, refresh
token support) live in app/oauth/providers.py's OAuthProviderConfig
instances, not here; this module only knows the standard RFC 6749
authorization-code grant.

ASSUMPTIONS (not live-tested against every real vendor -- same maturity
level as every other vendor integration in this codebase):
- Every provider's token endpoint accepts `Accept: application/json` and
  returns a JSON body with `access_token`, optionally `refresh_token` and
  `expires_in` (seconds). Jira/Atlassian requires a JSON request body; the
  rest use the usual OAuth form body. GitHub's classic OAuth apps omit
  `expires_in` entirely (tokens don't expire) -- treated as "never expires",
  not an error.
- `refresh_token` grant reuses the same token endpoint with
  `grant_type=refresh_token`, standard across all five OAuth2 vendors here.
- Slack's oauth.v2.access always returns HTTP 200, success or failure --
  errors are `{"ok": false, "error": "..."}` in an otherwise-200 body.
  Every other vendor here uses HTTP status codes for errors as RFC 6749
  expects; only Slack needs the body-level `ok` check in
  _parse_token_response, but it's cheap and harmless to check for every
  vendor (none of the others use an `ok` key at all).
"""

import base64
import hashlib
import hmac
import secrets
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel

from app.oauth.providers import OAuthProviderConfig

STATE_TTL_SECONDS = 600  # 10 minutes -- generous for a human to complete the vendor's consent screen


class OAuthStateError(Exception):
    """Raised for a missing/invalid/expired/tampered state param -- the
    callback must never trust an unsigned or expired state, since it
    carries which org this token grant belongs to."""


class OAuthTokenSet(BaseModel):
    access_token: str
    refresh_token: str | None = None
    expires_at: datetime | None = None  # None means "does not expire" (e.g. GitHub classic apps)
    # The full token-response body, verbatim. Slack's oauth.v2.access
    # response includes team.name/team.id directly here -- there's no
    # separate "userinfo" endpoint the way Google/GitHub have one, so a
    # callback needs the raw body, not just the three fields above.
    extra: dict = {}


def build_authorize_url(config: OAuthProviderConfig, *, state: str, redirect_uri: str) -> str:
    params = {
        "client_id": config.client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": config.scope,
        "state": state,
        **config.extra_authorize_params,
    }
    return f"{config.authorize_url}?{urlencode(params)}"


def sign_state(*, org_id: str, provider: str, secret: str, now: datetime | None = None) -> str:
    """Encodes org_id/provider/expiry into the state param and HMAC-signs
    it, so the callback can trust which org a grant belongs to without a
    separate server-side state table -- state is self-contained and
    tamper-evident, same reasoning a signed cookie would use."""
    now = now or datetime.now(UTC)
    expires_at = int(now.timestamp()) + STATE_TTL_SECONDS
    nonce = secrets.token_urlsafe(8)
    payload = f"{org_id}:{provider}:{expires_at}:{nonce}"
    payload_b64 = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    signature = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{signature}"


def verify_state(state: str, *, provider: str, secret: str) -> str:
    """Returns the org_id encoded in `state` if it's validly signed,
    unexpired, and for the expected provider. Raises OAuthStateError
    otherwise -- a forged or replayed state must never be trusted enough
    to attach a token grant to an org."""
    try:
        payload_b64, signature = state.split(".", 1)
    except ValueError as exc:
        raise OAuthStateError("malformed state") from exc

    expected_signature = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected_signature):
        raise OAuthStateError("state signature mismatch")

    padded = payload_b64 + "=" * (-len(payload_b64) % 4)
    try:
        payload = base64.urlsafe_b64decode(padded).decode()
        org_id, state_provider, expires_at_str, _nonce = payload.split(":", 3)
        expires_at = int(expires_at_str)
    except (ValueError, UnicodeDecodeError) as exc:
        raise OAuthStateError("malformed state payload") from exc

    if state_provider != provider:
        raise OAuthStateError(f"state was issued for provider {state_provider!r}, not {provider!r}")
    if time.time() > expires_at:
        raise OAuthStateError("state expired -- the consent flow took too long, try connecting again")

    return org_id


async def exchange_code_for_token(
    config: OAuthProviderConfig,
    *,
    code: str,
    redirect_uri: str,
    http_client: httpx.AsyncClient,
) -> OAuthTokenSet:
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": config.client_id,
        "client_secret": config.client_secret,
        **config.extra_token_params,
    }
    resp = await _post_token_request(http_client=http_client, config=config, data=data)
    resp.raise_for_status()
    return _parse_token_response(resp.json())


async def refresh_access_token(
    config: OAuthProviderConfig,
    *,
    refresh_token: str,
    http_client: httpx.AsyncClient,
) -> OAuthTokenSet:
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": config.client_id,
        "client_secret": config.client_secret,
    }
    resp = await _post_token_request(http_client=http_client, config=config, data=data)
    resp.raise_for_status()
    token_set = _parse_token_response(resp.json())
    if token_set.refresh_token is None:
        # Several vendors (Google included) omit refresh_token on a refresh
        # response -- the original one stays valid and must be preserved,
        # not dropped just because this particular response didn't repeat it.
        token_set = token_set.model_copy(update={"refresh_token": refresh_token})
    return token_set


class OAuthTokenExchangeError(Exception):
    """Raised when a vendor's token endpoint reports failure in the
    response BODY rather than the HTTP status -- Slack's oauth.v2.access
    always returns 200, success or not, with `{"ok": false, "error": ...}`
    on failure. httpx's raise_for_status() can't catch that; this can."""


async def _post_token_request(
    *,
    http_client: httpx.AsyncClient,
    config: OAuthProviderConfig,
    data: dict[str, str],
) -> httpx.Response:
    headers = {"Accept": "application/json"}
    if config.token_request_format == "json":
        return await http_client.post(
            config.token_url,
            json=data,
            headers={**headers, "Content-Type": "application/json"},
        )
    return await http_client.post(config.token_url, data=data, headers=headers)


def _parse_token_response(body: dict) -> OAuthTokenSet:
    if body.get("ok") is False:
        raise OAuthTokenExchangeError(body.get("error", "token exchange failed"))
    expires_in = body.get("expires_in")
    expires_at = datetime.now(UTC) + timedelta(seconds=expires_in) if expires_in else None
    return OAuthTokenSet(
        access_token=body["access_token"],
        refresh_token=body.get("refresh_token"),
        expires_at=expires_at,
        extra=body,
    )
