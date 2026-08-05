"""Per-vendor OAuthProviderConfig builders (app/oauth/providers.py) --
each must fail loudly when unconfigured and build correctly when it is."""

import pytest

from app.config import Settings
from app.oauth.providers import OAuthNotConfiguredError, get_provider_config


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


@pytest.mark.parametrize(
    "provider,id_field,secret_field",
    [
        ("google", "google_oauth_client_id", "google_oauth_client_secret"),
        ("slack", "slack_oauth_client_id", "slack_oauth_client_secret"),
        ("jira", "jira_oauth_client_id", "jira_oauth_client_secret"),
        ("github", "github_oauth_client_id", "github_oauth_client_secret"),
        ("linear", "linear_oauth_client_id", "linear_oauth_client_secret"),
        ("zoom", "zoom_oauth_client_id", "zoom_oauth_client_secret"),
    ],
)
def test_provider_raises_when_unconfigured(provider, id_field, secret_field):
    settings = _settings()

    with pytest.raises(OAuthNotConfiguredError):
        get_provider_config(provider, settings)


@pytest.mark.parametrize(
    "provider,id_field,secret_field",
    [
        ("google", "google_oauth_client_id", "google_oauth_client_secret"),
        ("slack", "slack_oauth_client_id", "slack_oauth_client_secret"),
        ("jira", "jira_oauth_client_id", "jira_oauth_client_secret"),
        ("github", "github_oauth_client_id", "github_oauth_client_secret"),
        ("linear", "linear_oauth_client_id", "linear_oauth_client_secret"),
        ("zoom", "zoom_oauth_client_id", "zoom_oauth_client_secret"),
    ],
)
def test_provider_builds_when_configured(provider, id_field, secret_field):
    settings = _settings(**{id_field: "cid", secret_field: "csecret"})

    config = get_provider_config(provider, settings)

    assert config.provider == provider
    assert config.client_id == "cid"
    assert config.client_secret == "csecret"
    assert config.authorize_url.startswith("https://")
    assert config.token_url.startswith("https://")
    assert config.scope


def test_unknown_provider_raises_value_error():
    settings = _settings()

    with pytest.raises(ValueError, match="unknown OAuth provider"):
        get_provider_config("not-a-real-vendor", settings)


def test_google_requests_offline_access_so_a_refresh_token_is_issued():
    settings = _settings(google_oauth_client_id="cid", google_oauth_client_secret="csecret")

    config = get_provider_config("google", settings)

    assert config.extra_authorize_params["access_type"] == "offline"
