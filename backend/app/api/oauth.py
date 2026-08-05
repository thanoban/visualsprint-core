"""OAuth connect/callback routes -- the actual "Connect X" flow behind
every frontend button (frontend/app/settings/connections/page.tsx).
app/oauth/flow.py has the RFC 6749 mechanics; this is where a completed
grant becomes a real row plus a stored token set.

Only `google` is wired to a real connection upsert so far (via the
existing CalendarConnection table -- Calendar/Meet/Gmail share this one
OAuth client, and that table already has exactly the columns a Google
grant needs: provider, account_email, secret_ref). Slack/Jira/GitHub/
Linear/Zoom need a new, more general connection table since none of them
are calendars -- that lands with each vendor in a follow-up, not invented
here ahead of being consumed.
"""

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters.secretstore_gcp import get_secretstore
from app.config import get_settings
from app.db.base import get_db
from app.db.models import CalendarConnection, Org
from app.oauth.flow import (
    OAuthStateError,
    OAuthTokenSet,
    build_authorize_url,
    exchange_code_for_token,
    sign_state,
    verify_state,
)
from app.oauth.providers import OAuthNotConfiguredError, get_provider_config

router = APIRouter(tags=["oauth"])


class ConnectionOut(BaseModel):
    provider: str
    account_email: str
    connected_at: str


@router.get("/api/v1/orgs/{org_id}/connections", response_model=list[ConnectionOut])
async def list_connections(org_id: str, db: Session = Depends(get_db)) -> list[ConnectionOut]:
    """Only CalendarConnection rows (google/microsoft) exist so far --
    Slack/Jira/GitHub/Linear/Zoom connections land with each vendor."""
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "org not found")
    connections = db.query(CalendarConnection).filter(CalendarConnection.org_id == org_id).all()
    return [
        ConnectionOut(
            provider=c.provider, account_email=c.account_email, connected_at=c.created_at.isoformat()
        )
        for c in connections
    ]

GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"


async def get_http_client() -> httpx.AsyncClient:
    """FastAPI dependency, overridable in tests via app.dependency_overrides
    -- same seam every other Depends() in this codebase uses, applied to an
    outbound HTTP client since this router is the first to make one
    directly from a route rather than through a connector class."""
    async with httpx.AsyncClient() as client:
        yield client


def _require_state_secret() -> str:
    settings = get_settings()
    if not settings.oauth_state_secret:
        raise HTTPException(500, "VS_OAUTH_STATE_SECRET not configured")
    return settings.oauth_state_secret


def _callback_redirect_uri(provider: str) -> str:
    settings = get_settings()
    return f"{settings.oauth_redirect_base_url}/api/v1/oauth/{provider}/callback"


@router.get("/api/v1/orgs/{org_id}/oauth/{provider}/authorize")
async def start_oauth(org_id: str, provider: str, db: Session = Depends(get_db)) -> RedirectResponse:
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "org not found")

    settings = get_settings()
    try:
        config = get_provider_config(provider, settings)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except OAuthNotConfiguredError as exc:
        raise HTTPException(503, str(exc)) from exc

    state = sign_state(org_id=org_id, provider=provider, secret=_require_state_secret())
    url = build_authorize_url(config, state=state, redirect_uri=_callback_redirect_uri(provider))
    return RedirectResponse(url)


@router.get("/api/v1/oauth/{provider}/callback")
async def oauth_callback(
    provider: str,
    code: str,
    state: str,
    db: Session = Depends(get_db),
    http_client: httpx.AsyncClient = Depends(get_http_client),
) -> RedirectResponse:
    try:
        org_id = verify_state(state, provider=provider, secret=_require_state_secret())
    except OAuthStateError as exc:
        raise HTTPException(400, str(exc)) from exc

    if db.get(Org, org_id) is None:
        raise HTTPException(404, "org not found")

    settings = get_settings()
    try:
        config = get_provider_config(provider, settings)
    except (ValueError, OAuthNotConfiguredError) as exc:
        raise HTTPException(400, str(exc)) from exc

    try:
        token_set = await exchange_code_for_token(
            config, code=code, redirect_uri=_callback_redirect_uri(provider), http_client=http_client
        )
    except httpx.HTTPStatusError as exc:
        raise HTTPException(502, f"{provider} rejected the authorization code: {exc}") from exc

    if provider == "google":
        await _finish_google_connection(db, org_id, token_set, http_client)
    else:
        raise HTTPException(400, f"connecting {provider!r} is not wired up yet")

    return RedirectResponse(f"{settings.frontend_base_url}/settings/connections?connected={provider}")


async def _finish_google_connection(
    db: Session, org_id: str, token_set: OAuthTokenSet, http_client: httpx.AsyncClient
) -> None:
    resp = await http_client.get(
        GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {token_set.access_token}"}
    )
    resp.raise_for_status()
    account_email = resp.json().get("email")
    if not account_email:
        raise HTTPException(502, "Google userinfo response did not include an email")

    connection = (
        db.query(CalendarConnection)
        .filter(CalendarConnection.org_id == org_id, CalendarConnection.provider == "google")
        .one_or_none()
    )
    if connection is None:
        connection = CalendarConnection(
            org_id=org_id, provider="google", account_email=account_email, secret_ref=""
        )
        db.add(connection)
        db.flush()  # need connection.id before the secret_ref name can include it
        connection.secret_ref = f"oauth/google/{connection.id}"
    else:
        connection.account_email = account_email

    await get_secretstore().put(connection.secret_ref, token_set.model_dump_json())
    db.commit()
