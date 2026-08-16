"""Per-vendor OAuth 2.0 configuration -- authorize/token URLs, scopes, and
whatever a vendor needs beyond the RFC 6749 baseline app/oauth/flow.py
implements. Client id/secret come from app.config.Settings (one app
registration per vendor, covers every customer org -- see .env.example's
OAuth section for what to register where).

Scope strings and extra params are ASSUMPTIONS from each vendor's public
documentation, NOT live-verified -- no OAuth app is registered for any of
these yet. Re-check the exact required scopes against each vendor's
current app-registration UI when actually registering; Zoom in particular
has changed its granular-scope naming more than once.
"""

from dataclasses import dataclass, field

from app.config import Settings


@dataclass
class OAuthProviderConfig:
    provider: str
    client_id: str
    client_secret: str
    authorize_url: str
    token_url: str
    scope: str
    extra_authorize_params: dict[str, str] = field(default_factory=dict)
    extra_token_params: dict[str, str] = field(default_factory=dict)
    token_request_format: str = "form"


class OAuthNotConfiguredError(Exception):
    """Raised when a provider's client_id/client_secret aren't set yet --
    fails loudly rather than building an authorize URL that can't work."""


def _require(value: str | None, *, setting_name: str) -> str:
    if not value:
        raise OAuthNotConfiguredError(f"{setting_name} is not configured")
    return value


def google_config(settings: Settings) -> OAuthProviderConfig:
    return OAuthProviderConfig(
        provider="google",
        client_id=_require(settings.google_oauth_client_id, setting_name="VS_GOOGLE_OAUTH_CLIENT_ID"),
        client_secret=_require(
            settings.google_oauth_client_secret, setting_name="VS_GOOGLE_OAUTH_CLIENT_SECRET"
        ),
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        # Calendar (event discovery), Meet REST (recording/transcript
        # fetch), Drive (Meet stores the recording file there), Gmail
        # drafts (email_draft connector) -- one grant covers every
        # capture/action surface that shares this one OAuth client.
        # userinfo.email is required too, not optional: _finish_google_
        # connection calls Google's userinfo endpoint to learn the
        # connecting account's email (stored as CalendarConnection.
        # account_email), and that call 401s without it -- confirmed live
        # against a real production callback, not assumed. The access
        # token this client receives is only authorized for whatever
        # scopes were actually requested; wanting the caller's identity
        # needs its own explicit scope like any other permission here.
        scope=(
            "https://www.googleapis.com/auth/calendar.readonly "
            "https://www.googleapis.com/auth/meetings.space.readonly "
            "https://www.googleapis.com/auth/drive.readonly "
            "https://www.googleapis.com/auth/gmail.compose "
            "https://www.googleapis.com/auth/userinfo.email"
        ),
        extra_authorize_params={
            # offline access -> refresh_token issued; prompt=consent forces
            # Google to re-issue one even on a repeat authorization (a
            # refresh_token is otherwise only returned on the FIRST
            # consent for a given client_id/user pair).
            "access_type": "offline",
            "prompt": "consent",
        },
    )


def slack_config(settings: Settings) -> OAuthProviderConfig:
    return OAuthProviderConfig(
        provider="slack",
        client_id=_require(settings.slack_oauth_client_id, setting_name="VS_SLACK_OAUTH_CLIENT_ID"),
        client_secret=_require(
            settings.slack_oauth_client_secret, setting_name="VS_SLACK_OAUTH_CLIENT_SECRET"
        ),
        authorize_url="https://slack.com/oauth/v2/authorize",
        token_url="https://slack.com/api/oauth.v2.access",
        scope="chat:write",  # channel_recap connector posts as this bot
    )


def jira_config(settings: Settings) -> OAuthProviderConfig:
    return OAuthProviderConfig(
        provider="jira",
        client_id=_require(settings.jira_oauth_client_id, setting_name="VS_JIRA_OAUTH_CLIENT_ID"),
        client_secret=_require(
            settings.jira_oauth_client_secret, setting_name="VS_JIRA_OAUTH_CLIENT_SECRET"
        ),
        authorize_url="https://auth.atlassian.com/authorize",
        token_url="https://auth.atlassian.com/oauth/token",
        scope="write:jira-work offline_access",  # offline_access -> refresh_token issued
        extra_authorize_params={"audience": "api.atlassian.com", "prompt": "consent"},
        token_request_format="json",
    )


def github_config(settings: Settings) -> OAuthProviderConfig:
    return OAuthProviderConfig(
        provider="github",
        client_id=_require(settings.github_oauth_client_id, setting_name="VS_GITHUB_OAUTH_CLIENT_ID"),
        client_secret=_require(
            settings.github_oauth_client_secret, setting_name="VS_GITHUB_OAUTH_CLIENT_SECRET"
        ),
        authorize_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",
        scope="repo",  # task_create connector opens issues
    )


def linear_config(settings: Settings) -> OAuthProviderConfig:
    return OAuthProviderConfig(
        provider="linear",
        client_id=_require(settings.linear_oauth_client_id, setting_name="VS_LINEAR_OAUTH_CLIENT_ID"),
        client_secret=_require(
            settings.linear_oauth_client_secret, setting_name="VS_LINEAR_OAUTH_CLIENT_SECRET"
        ),
        authorize_url="https://linear.app/oauth/authorize",
        token_url="https://api.linear.app/oauth/token",
        scope="write",
        extra_authorize_params={"actor": "application"},
    )


def zoom_config(settings: Settings) -> OAuthProviderConfig:
    """This is the General OAuth App -- distinct from VS_ZOOM_CLIENT_ID's
    Server-to-Server app (rtms_webhook.py). Only a General App can be
    authorized by a customer's own Zoom account."""
    return OAuthProviderConfig(
        provider="zoom",
        client_id=_require(settings.zoom_oauth_client_id, setting_name="VS_ZOOM_OAUTH_CLIENT_ID"),
        client_secret=_require(
            settings.zoom_oauth_client_secret, setting_name="VS_ZOOM_OAUTH_CLIENT_SECRET"
        ),
        authorize_url="https://zoom.us/oauth/authorize",
        token_url="https://zoom.us/oauth/token",
        # user:read:user — lets us call /v2/users/me to get account_id,
        # which is the only thing this General OAuth grant does (RTMS stream
        # auth uses the separate Server-to-Server app credentials).
        # Mode A2 cloud-recording scopes can be added here later once RTMS
        # capture is proven end-to-end.
        scope="user:read:user",
    )


def microsoft_config(settings: Settings) -> OAuthProviderConfig:
    """Azure AD v2.0 endpoint, "common" tenant -- accepts both work/school
    and personal Microsoft accounts. A personal account won't have a Teams/
    Exchange calendar behind it, so Mode A2 capture and calendar watch
    degrade to "nothing found" for that account rather than failing the
    connection itself; same non-fatal-degrade shape as every other optional
    integration in this codebase."""
    return OAuthProviderConfig(
        provider="microsoft",
        client_id=_require(
            settings.microsoft_oauth_client_id, setting_name="VS_MICROSOFT_OAUTH_CLIENT_ID"
        ),
        client_secret=_require(
            settings.microsoft_oauth_client_secret, setting_name="VS_MICROSOFT_OAUTH_CLIENT_SECRET"
        ),
        authorize_url="https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url="https://login.microsoftonline.com/common/oauth2/v2.0/token",
        # offline_access -> refresh_token issued (Graph tokens are short-lived
        # by design, unlike Google's). User.Read resolves the connected
        # account's email at connect time; Calendars.Read backs
        # calendar_microsoft.py.
        #
        # OnlineMeetings.Read.All (would back teams_adapter.py's Mode A2
        # capture) is deliberately NOT requested here -- it's a Microsoft
        # 365-for-business-only Graph permission that doesn't exist for
        # personal/consumer Microsoft accounts, so requesting it up front
        # makes Microsoft reject the *entire* grant with invalid_scope for
        # any personal account, not just degrade that one capability.
        # Teams Mode A2 capture is unavailable until this is requested via a
        # separate incremental-consent step scoped to work/school accounts
        # only -- not yet built.
        scope="offline_access User.Read Calendars.Read",
    )


PROVIDERS = {
    "google": google_config,
    "slack": slack_config,
    "jira": jira_config,
    "github": github_config,
    "linear": linear_config,
    "zoom": zoom_config,
    "microsoft": microsoft_config,
}


def get_provider_config(provider: str, settings: Settings) -> OAuthProviderConfig:
    builder = PROVIDERS.get(provider)
    if builder is None:
        raise ValueError(f"unknown OAuth provider: {provider!r}")
    return builder(settings)
