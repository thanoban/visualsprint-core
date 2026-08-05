"""OAuth connect/callback routes -- the actual "Connect X" flow behind
every frontend button (frontend/app/settings/connections/page.tsx).
app/oauth/flow.py has the RFC 6749 mechanics; this is where a completed
grant becomes a real row plus a stored token set.

google lives in CalendarConnection (Calendar/Meet/Gmail share this one
OAuth client, and that table already had exactly the columns a Google
grant needs -- no new table for it). github/linear/slack/jira/zoom live in
OrgConnection (app/db/models.py's comment on why they're separate from
CalendarConnection). google/github/linear/slack/jira are wired to a real
connection upsert; zoom lands in its own follow-up (needs a different
Zoom app type than the Server-to-Server one already registered -- see
app/capture/rtms_client.py).
"""

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters.secretstore_gcp import get_secretstore
from app.config import get_settings
from app.db.base import get_db
from app.db.models import CalendarConnection, Org, OrgConnection
from app.oauth.flow import (
    OAuthStateError,
    OAuthTokenExchangeError,
    OAuthTokenSet,
    build_authorize_url,
    exchange_code_for_token,
    sign_state,
    verify_state,
)
from app.oauth.providers import OAuthNotConfiguredError, get_provider_config

router = APIRouter(tags=["oauth"])

GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GITHUB_USER_URL = "https://api.github.com/user"
LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
ATLASSIAN_ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources"


class ConnectionOut(BaseModel):
    provider: str
    account_label: str
    connected_at: str


@router.get("/api/v1/orgs/{org_id}/connections", response_model=list[ConnectionOut])
async def list_connections(org_id: str, db: Session = Depends(get_db)) -> list[ConnectionOut]:
    if db.get(Org, org_id) is None:
        raise HTTPException(404, "org not found")

    calendar_connections = db.query(CalendarConnection).filter(CalendarConnection.org_id == org_id).all()
    org_connections = db.query(OrgConnection).filter(OrgConnection.org_id == org_id).all()
    return [
        ConnectionOut(
            provider=c.provider, account_label=c.account_email, connected_at=c.created_at.isoformat()
        )
        for c in calendar_connections
    ] + [
        ConnectionOut(
            provider=c.provider, account_label=c.account_label, connected_at=c.created_at.isoformat()
        )
        for c in org_connections
    ]


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
    except (httpx.HTTPStatusError, OAuthTokenExchangeError) as exc:
        raise HTTPException(502, f"{provider} rejected the authorization code: {exc}") from exc

    if provider == "google":
        await _finish_google_connection(db, org_id, token_set, http_client)
    elif provider == "github":
        await _finish_github_connection(db, org_id, token_set, http_client)
    elif provider == "linear":
        await _finish_linear_connection(db, org_id, token_set, http_client)
    elif provider == "slack":
        await _finish_slack_connection(db, org_id, token_set)
    elif provider == "jira":
        await _finish_jira_connection(db, org_id, token_set, http_client)
    else:
        raise HTTPException(400, f"connecting {provider!r} is not wired up yet")

    return RedirectResponse(f"{settings.frontend_base_url}/settings/connections?connected={provider}")


async def _upsert_org_connection(
    db: Session,
    org_id: str,
    provider: str,
    account_label: str,
    token_set: OAuthTokenSet,
    *,
    external_id: str | None = None,
) -> None:
    connection = (
        db.query(OrgConnection)
        .filter(OrgConnection.org_id == org_id, OrgConnection.provider == provider)
        .one_or_none()
    )
    if connection is None:
        connection = OrgConnection(
            org_id=org_id,
            provider=provider,
            account_label=account_label,
            external_id=external_id,
            secret_ref="",
        )
        db.add(connection)
        db.flush()  # need connection.id before the secret_ref name can include it
        connection.secret_ref = f"oauth/{provider}/{connection.id}"
    else:
        connection.account_label = account_label
        connection.external_id = external_id

    await get_secretstore().put(connection.secret_ref, token_set.model_dump_json())
    db.commit()


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
        db.flush()
        connection.secret_ref = f"oauth/google/{connection.id}"
    else:
        connection.account_email = account_email

    await get_secretstore().put(connection.secret_ref, token_set.model_dump_json())
    db.commit()


async def _finish_github_connection(
    db: Session, org_id: str, token_set: OAuthTokenSet, http_client: httpx.AsyncClient
) -> None:
    resp = await http_client.get(
        GITHUB_USER_URL,
        headers={
            "Authorization": f"Bearer {token_set.access_token}",
            "Accept": "application/vnd.github+json",
        },
    )
    resp.raise_for_status()
    username = resp.json().get("login")
    if not username:
        raise HTTPException(502, "GitHub user response did not include a login")
    await _upsert_org_connection(db, org_id, "github", username, token_set)


async def _finish_linear_connection(
    db: Session, org_id: str, token_set: OAuthTokenSet, http_client: httpx.AsyncClient
) -> None:
    resp = await http_client.post(
        LINEAR_GRAPHQL_URL,
        headers={"Authorization": f"Bearer {token_set.access_token}"},
        json={"query": "{ organization { name } }"},
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("errors"):
        raise HTTPException(502, f"Linear organization query returned errors: {data['errors']}")
    org_name = data.get("data", {}).get("organization", {}).get("name")
    if not org_name:
        raise HTTPException(502, "Linear organization query did not return a name")
    await _upsert_org_connection(db, org_id, "linear", org_name, token_set)


async def _finish_slack_connection(db: Session, org_id: str, token_set: OAuthTokenSet) -> None:
    """No separate userinfo call needed -- Slack's oauth.v2.access response
    already carries team.name/team.id (see app/oauth/flow.py's
    OAuthTokenSet.extra, which preserves the full body for exactly this)."""
    team = token_set.extra.get("team") or {}
    team_name = team.get("name")
    if not team_name:
        raise HTTPException(502, "Slack token response did not include a team name")
    await _upsert_org_connection(
        db, org_id, "slack", team_name, token_set, external_id=team.get("id")
    )


async def _finish_jira_connection(
    db: Session, org_id: str, token_set: OAuthTokenSet, http_client: httpx.AsyncClient
) -> None:
    """Atlassian OAuth 2.0 (3LO) has no single "the site" the way a Google
    account has one email -- a grant can cover multiple Jira sites. This
    MVP takes the first accessible one (typical case: a customer connects
    exactly one site) rather than building a site-picker UI. account_label
    stores the site's URL (not just its name) because
    app/connectors/task_create.py needs it verbatim to build issue browse
    links -- OrgConnection has nowhere else to put it."""
    resp = await http_client.get(
        ATLASSIAN_ACCESSIBLE_RESOURCES_URL,
        headers={"Authorization": f"Bearer {token_set.access_token}"},
    )
    resp.raise_for_status()
    resources = resp.json()
    if not resources:
        raise HTTPException(502, "Atlassian account has no accessible Jira sites")

    site = resources[0]
    site_url = site.get("url")
    cloud_id = site.get("id")
    if not site_url or not cloud_id:
        raise HTTPException(502, "Atlassian accessible-resources response missing url/id")

    await _upsert_org_connection(db, org_id, "jira", site_url, token_set, external_id=cloud_id)
