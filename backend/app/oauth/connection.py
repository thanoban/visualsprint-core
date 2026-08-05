"""Resolves a real per-org OAuthTokenProvider for a given vendor
`provider`, or None if the org hasn't connected it. Shared by every place
that builds a connector/adapter for a specific org's own grant --
app/api/actions.py's connector registry, app/orchestrator/worker.py's
calendar sync and Mode A2 platform-adapter construction. Consolidated
here after being written nearly identically three times; each of those
call sites getting this lookup right matters (an org must never end up
using another org's token), so one implementation is worth it.

"google"/"microsoft" live in CalendarConnection; everything else
(slack/jira/github/linear/zoom) lives in OrgConnection -- see
app/db/models.py's comment on why they're split.
"""

from sqlalchemy.orm import Session

from app.adapters.secretstore_gcp import get_secretstore
from app.capture.oauth_token_provider import OAuthTokenProvider
from app.config import get_settings
from app.db.models import CalendarConnection, OrgConnection
from app.oauth.providers import OAuthNotConfiguredError, get_provider_config

_CALENDAR_PROVIDERS = {"google", "microsoft"}


def get_org_connection(db: Session, org_id: str, provider: str):
    """Returns the CalendarConnection or OrgConnection row for this org's
    grant to `provider`, or None if never connected. Exposed separately
    from build_org_token_provider below because some callers need
    connection metadata beyond the token itself (e.g. Jira's cloud_id/
    site_url in app/api/actions.py)."""
    if provider in _CALENDAR_PROVIDERS:
        return (
            db.query(CalendarConnection)
            .filter(CalendarConnection.org_id == org_id, CalendarConnection.provider == provider)
            .one_or_none()
        )
    return (
        db.query(OrgConnection)
        .filter(OrgConnection.org_id == org_id, OrgConnection.provider == provider)
        .one_or_none()
    )


def build_org_token_provider(db: Session, org_id: str, provider: str) -> OAuthTokenProvider | None:
    """None means "not usable right now" -- either the org never connected
    this provider, or the org connected before the app's own OAuth
    client_id/secret got unset or was never configured in this
    environment. Callers fall back to UnconfiguredTokenProvider."""
    connection = get_org_connection(db, org_id, provider)
    if connection is None:
        return None

    try:
        provider_config = get_provider_config(provider, get_settings())
    except OAuthNotConfiguredError:
        return None

    return OAuthTokenProvider(
        secret_ref=connection.secret_ref, provider_config=provider_config, secret_store=get_secretstore()
    )
