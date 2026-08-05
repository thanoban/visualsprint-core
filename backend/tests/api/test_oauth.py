"""OAuth connect/callback routes (app/api/oauth.py) -- the actual "Connect
X" flow. Uses the real LocalSecretStore default (writes small files under
.secretstore/, gitignored, same convention test_data_rights.py already
uses for LocalBlobStore rather than mocking it)."""

import httpx
import pytest

from app.api.oauth import get_http_client
from app.config import get_settings
from app.db.models import CalendarConnection, Org, OrgConnection
from app.main import app
from app.oauth.flow import sign_state


@pytest.fixture(autouse=True)
def _oauth_env(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("VS_OAUTH_STATE_SECRET", "test-signing-secret")
    monkeypatch.setenv("VS_GOOGLE_OAUTH_CLIENT_ID", "google-cid")
    monkeypatch.setenv("VS_GOOGLE_OAUTH_CLIENT_SECRET", "google-csecret")
    monkeypatch.setenv("VS_GITHUB_OAUTH_CLIENT_ID", "github-cid")
    monkeypatch.setenv("VS_GITHUB_OAUTH_CLIENT_SECRET", "github-csecret")
    monkeypatch.setenv("VS_LINEAR_OAUTH_CLIENT_ID", "linear-cid")
    monkeypatch.setenv("VS_LINEAR_OAUTH_CLIENT_SECRET", "linear-csecret")
    monkeypatch.setenv("VS_SLACK_OAUTH_CLIENT_ID", "slack-cid")
    monkeypatch.setenv("VS_SLACK_OAUTH_CLIENT_SECRET", "slack-csecret")
    monkeypatch.setenv("VS_JIRA_OAUTH_CLIENT_ID", "jira-cid")
    monkeypatch.setenv("VS_JIRA_OAUTH_CLIENT_SECRET", "jira-csecret")
    monkeypatch.setenv("VS_ZOOM_OAUTH_CLIENT_ID", "zoom-cid")
    monkeypatch.setenv("VS_ZOOM_OAUTH_CLIENT_SECRET", "zoom-csecret")
    monkeypatch.setenv("VS_MICROSOFT_OAUTH_CLIENT_ID", "microsoft-cid")
    monkeypatch.setenv("VS_MICROSOFT_OAUTH_CLIENT_SECRET", "microsoft-csecret")
    monkeypatch.setenv("VS_OAUTH_REDIRECT_BASE_URL", "https://api.test")
    monkeypatch.setenv("VS_FRONTEND_BASE_URL", "https://app.test")
    yield
    get_settings.cache_clear()


def _override_http_client(handler):
    async def _get():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            yield client

    return _get


def _seed_org(db_session) -> Org:
    org = Org(name="acme")
    db_session.add(org)
    db_session.commit()
    return org


def test_start_oauth_404s_for_unknown_org(client):
    resp = client.get(
        "/api/v1/orgs/does-not-exist/oauth/google/authorize", follow_redirects=False
    )
    assert resp.status_code == 404


def test_start_oauth_404s_for_unknown_provider(client, db_session):
    org = _seed_org(db_session)
    resp = client.get(
        f"/api/v1/orgs/{org.id}/oauth/not-a-real-vendor/authorize", follow_redirects=False
    )
    assert resp.status_code == 404


def test_start_oauth_503s_when_provider_not_configured(client, db_session, monkeypatch):
    org = _seed_org(db_session)
    monkeypatch.delenv("VS_SLACK_OAUTH_CLIENT_ID", raising=False)
    get_settings.cache_clear()

    resp = client.get(f"/api/v1/orgs/{org.id}/oauth/slack/authorize", follow_redirects=False)

    assert resp.status_code == 503


def test_start_oauth_redirects_to_the_vendor_authorize_url_with_a_signed_state(
    client, db_session
):
    org = _seed_org(db_session)

    resp = client.get(f"/api/v1/orgs/{org.id}/oauth/google/authorize", follow_redirects=False)

    assert resp.status_code in (302, 307)
    location = resp.headers["location"]
    assert location.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "client_id=google-cid" in location
    assert "state=" in location


def test_callback_400s_for_an_invalid_state(client):
    resp = client.get(
        "/api/v1/oauth/google/callback", params={"code": "c", "state": "garbage"},
        follow_redirects=False,
    )
    assert resp.status_code == 400


def test_callback_400s_when_state_was_signed_for_a_different_provider(client, db_session):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="slack", secret="test-signing-secret")

    resp = client.get(
        "/api/v1/oauth/google/callback", params={"code": "c", "state": state},
        follow_redirects=False,
    )

    assert resp.status_code == 400


def test_callback_creates_a_calendar_connection_and_redirects_to_the_frontend(
    client, db_session
):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="google", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            return httpx.Response(
                200,
                json={"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600},
            )
        if request.url.path == "/oauth2/v2/userinfo":
            return httpx.Response(200, json={"email": "team@acme.test"})
        raise AssertionError(f"unexpected request to {request.url}")

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/google/callback", params={"code": "auth-code", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code in (302, 307)
    assert resp.headers["location"] == "https://app.test/settings/connections?connected=google"

    connection = (
        db_session.query(CalendarConnection)
        .filter(CalendarConnection.org_id == org.id, CalendarConnection.provider == "google")
        .one()
    )
    assert connection.account_email == "team@acme.test"
    assert connection.secret_ref == f"oauth/google/{connection.id}"


def test_callback_reconnecting_updates_the_existing_connection_not_a_duplicate(
    client, db_session
):
    org = _seed_org(db_session)
    existing = CalendarConnection(
        org_id=org.id, provider="google", account_email="old@acme.test", secret_ref="oauth/google/existing"
    )
    db_session.add(existing)
    db_session.commit()

    state = sign_state(org_id=org.id, provider="google", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            return httpx.Response(200, json={"access_token": "at-2", "expires_in": 3600})
        return httpx.Response(200, json={"email": "new@acme.test"})

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        client.get(
            "/api/v1/oauth/google/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    connections = (
        db_session.query(CalendarConnection)
        .filter(CalendarConnection.org_id == org.id, CalendarConnection.provider == "google")
        .all()
    )
    assert len(connections) == 1
    assert connections[0].account_email == "new@acme.test"
    assert connections[0].secret_ref == "oauth/google/existing"  # unchanged, not regenerated


def test_callback_400s_for_an_unknown_provider_name(client, db_session):
    """All seven real vendors are wired now -- the "not wired up yet" branch
    is purely defensive for a hypothetical future ActionKind/provider,
    unreachable through the normal flow since get_provider_config already
    rejects anything not in its PROVIDERS map before this branch is
    reached. Exercised here by forging a state for a name that was never
    registered."""
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="not-a-real-vendor", secret="test-signing-secret")

    resp = client.get(
        "/api/v1/oauth/not-a-real-vendor/callback", params={"code": "c", "state": state},
        follow_redirects=False,
    )

    assert resp.status_code == 400


def test_list_connections_404s_for_unknown_org(client):
    resp = client.get("/api/v1/orgs/does-not-exist/connections")
    assert resp.status_code == 404


def test_list_connections_is_empty_for_an_org_with_no_connections(client, db_session):
    org = _seed_org(db_session)
    resp = client.get(f"/api/v1/orgs/{org.id}/connections")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_connections_returns_a_connected_google_account(client, db_session):
    org = _seed_org(db_session)
    db_session.add(
        CalendarConnection(
            org_id=org.id, provider="google", account_email="team@acme.test", secret_ref="oauth/google/x"
        )
    )
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{org.id}/connections")

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["provider"] == "google"
    assert body[0]["account_label"] == "team@acme.test"


def test_list_connections_includes_org_connections_alongside_calendar_connections(client, db_session):
    org = _seed_org(db_session)
    db_session.add(
        CalendarConnection(
            org_id=org.id, provider="google", account_email="team@acme.test", secret_ref="oauth/google/x"
        )
    )
    db_session.add(
        OrgConnection(
            org_id=org.id, provider="github", account_label="acme-bot", secret_ref="oauth/github/x"
        )
    )
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{org.id}/connections")

    assert resp.status_code == 200
    providers = {c["provider"] for c in resp.json()}
    assert providers == {"google", "github"}


def test_callback_creates_a_github_org_connection(client, db_session):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="github", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/login/oauth/access_token":
            return httpx.Response(200, json={"access_token": "gh-token"})
        if request.url.path == "/user":
            return httpx.Response(200, json={"login": "acme-bot"})
        raise AssertionError(f"unexpected request to {request.url}")

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/github/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code in (302, 307)
    assert resp.headers["location"] == "https://app.test/settings/connections?connected=github"

    connection = (
        db_session.query(OrgConnection)
        .filter(OrgConnection.org_id == org.id, OrgConnection.provider == "github")
        .one()
    )
    assert connection.account_label == "acme-bot"
    assert connection.secret_ref == f"oauth/github/{connection.id}"


def test_callback_400s_when_github_user_response_has_no_login(client, db_session):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="github", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/login/oauth/access_token":
            return httpx.Response(200, json={"access_token": "gh-token"})
        return httpx.Response(200, json={})  # no "login" field

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/github/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code == 502


def test_callback_creates_a_linear_org_connection(client, db_session):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="linear", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/token":
            return httpx.Response(200, json={"access_token": "linear-token", "expires_in": 3600})
        if request.url.path == "/graphql":
            assert request.headers["authorization"] == "Bearer linear-token"
            return httpx.Response(200, json={"data": {"organization": {"name": "Acme Inc"}}})
        raise AssertionError(f"unexpected request to {request.url}")

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/linear/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code in (302, 307)
    connection = (
        db_session.query(OrgConnection)
        .filter(OrgConnection.org_id == org.id, OrgConnection.provider == "linear")
        .one()
    )
    assert connection.account_label == "Acme Inc"


def test_callback_reconnecting_github_updates_the_existing_connection_not_a_duplicate(
    client, db_session
):
    org = _seed_org(db_session)
    existing = OrgConnection(
        org_id=org.id, provider="github", account_label="old-bot", secret_ref="oauth/github/existing"
    )
    db_session.add(existing)
    db_session.commit()

    state = sign_state(org_id=org.id, provider="github", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/login/oauth/access_token":
            return httpx.Response(200, json={"access_token": "gh-token-2"})
        return httpx.Response(200, json={"login": "new-bot"})

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        client.get(
            "/api/v1/oauth/github/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    connections = (
        db_session.query(OrgConnection)
        .filter(OrgConnection.org_id == org.id, OrgConnection.provider == "github")
        .all()
    )
    assert len(connections) == 1
    assert connections[0].account_label == "new-bot"
    assert connections[0].secret_ref == "oauth/github/existing"  # unchanged, not regenerated


def test_callback_creates_a_slack_org_connection_with_no_extra_api_call(client, db_session):
    """Slack's team info comes from the token response itself -- unlike
    google/github/linear, this callback should make exactly one outbound
    request (the token exchange), no separate userinfo/GraphQL call."""
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="slack", secret="test-signing-secret")
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(
            200,
            json={
                "ok": True,
                "access_token": "xoxb-1",
                "team": {"id": "T123", "name": "Acme Workspace"},
            },
        )

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/slack/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code in (302, 307)
    assert len(calls) == 1  # token exchange only

    connection = (
        db_session.query(OrgConnection)
        .filter(OrgConnection.org_id == org.id, OrgConnection.provider == "slack")
        .one()
    )
    assert connection.account_label == "Acme Workspace"
    assert connection.external_id == "T123"


def test_callback_502s_when_slack_rejects_the_code(client, db_session):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="slack", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        # Slack returns HTTP 200 even on failure -- this must still surface
        # as a clean error, not silently create a connection.
        return httpx.Response(200, json={"ok": False, "error": "invalid_code"})

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/slack/callback", params={"code": "bad", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code == 502
    assert (
        db_session.query(OrgConnection)
        .filter(OrgConnection.org_id == org.id, OrgConnection.provider == "slack")
        .one_or_none()
        is None
    )


def test_callback_creates_a_jira_org_connection_with_the_first_accessible_site(client, db_session):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="jira", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/token":
            return httpx.Response(
                200, json={"access_token": "jira-token", "refresh_token": "rt-1", "expires_in": 3600}
            )
        if request.url.path == "/oauth/token/accessible-resources":
            assert request.headers["authorization"] == "Bearer jira-token"
            return httpx.Response(
                200,
                json=[
                    {"id": "cloud-abc", "url": "https://acme.atlassian.net", "name": "Acme"},
                    {"id": "cloud-def", "url": "https://other.atlassian.net", "name": "Other"},
                ],
            )
        raise AssertionError(f"unexpected request to {request.url}")

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/jira/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code in (302, 307)
    connection = (
        db_session.query(OrgConnection)
        .filter(OrgConnection.org_id == org.id, OrgConnection.provider == "jira")
        .one()
    )
    assert connection.account_label == "https://acme.atlassian.net"  # first resource, not "Other"
    assert connection.external_id == "cloud-abc"


def test_callback_502s_when_jira_account_has_no_accessible_sites(client, db_session):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="jira", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/token":
            return httpx.Response(200, json={"access_token": "jira-token"})
        return httpx.Response(200, json=[])

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/jira/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code == 502


def test_callback_creates_a_zoom_org_connection_with_account_id_as_external_id(client, db_session):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="zoom", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/token":
            return httpx.Response(200, json={"access_token": "zoom-token", "expires_in": 3600})
        if request.url.path == "/v2/users/me":
            assert request.headers["authorization"] == "Bearer zoom-token"
            return httpx.Response(
                200, json={"account_id": "Abc123XYZ", "email": "ops@acme.test"}
            )
        raise AssertionError(f"unexpected request to {request.url}")

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/zoom/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code in (302, 307)
    connection = (
        db_session.query(OrgConnection)
        .filter(OrgConnection.org_id == org.id, OrgConnection.provider == "zoom")
        .one()
    )
    assert connection.account_label == "ops@acme.test"
    assert connection.external_id == "Abc123XYZ"


def test_callback_502s_when_zoom_users_me_omits_account_id(client, db_session):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="zoom", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/token":
            return httpx.Response(200, json={"access_token": "zoom-token"})
        return httpx.Response(200, json={"email": "ops@acme.test"})  # no account_id

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/zoom/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code == 502


def test_callback_creates_a_microsoft_calendar_connection(client, db_session):
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="microsoft", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/organizations/oauth2/v2.0/token":
            return httpx.Response(
                200, json={"access_token": "ms-token", "refresh_token": "rt-1", "expires_in": 3600}
            )
        if request.url.path == "/v1.0/me":
            assert request.headers["authorization"] == "Bearer ms-token"
            return httpx.Response(
                200, json={"mail": "ops@acme.test", "userPrincipalName": "ops@acme.onmicrosoft.com"}
            )
        raise AssertionError(f"unexpected request to {request.url}")

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/microsoft/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code in (302, 307)
    connection = (
        db_session.query(CalendarConnection)
        .filter(CalendarConnection.org_id == org.id, CalendarConnection.provider == "microsoft")
        .one()
    )
    assert connection.account_email == "ops@acme.test"  # mail preferred over userPrincipalName
    assert connection.secret_ref == f"oauth/microsoft/{connection.id}"


def test_callback_falls_back_to_user_principal_name_when_mail_is_null(client, db_session):
    """Accounts without an Exchange mailbox license have mail=null --
    userPrincipalName (the sign-in identifier) is always present."""
    org = _seed_org(db_session)
    state = sign_state(org_id=org.id, provider="microsoft", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/organizations/oauth2/v2.0/token":
            return httpx.Response(200, json={"access_token": "ms-token", "expires_in": 3600})
        return httpx.Response(
            200, json={"mail": None, "userPrincipalName": "ops@acme.onmicrosoft.com"}
        )

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        client.get(
            "/api/v1/oauth/microsoft/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    connection = (
        db_session.query(CalendarConnection)
        .filter(CalendarConnection.org_id == org.id, CalendarConnection.provider == "microsoft")
        .one()
    )
    assert connection.account_email == "ops@acme.onmicrosoft.com"


def test_google_and_microsoft_connections_coexist_for_the_same_org(client, db_session):
    """CalendarConnection's provider column distinguishes them -- an org
    connecting both must get two rows, not one overwriting the other."""
    org = _seed_org(db_session)
    db_session.add(
        CalendarConnection(
            org_id=org.id, provider="google", account_email="g@acme.test", secret_ref="oauth/google/x"
        )
    )
    db_session.commit()

    state = sign_state(org_id=org.id, provider="microsoft", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        if "token" in request.url.path:
            return httpx.Response(200, json={"access_token": "ms-token"})
        return httpx.Response(200, json={"mail": "ms@acme.test"})

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        client.get(
            "/api/v1/oauth/microsoft/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    resp = client.get(f"/api/v1/orgs/{org.id}/connections")
    providers = {c["provider"] for c in resp.json()}
    assert providers == {"google", "microsoft"}
