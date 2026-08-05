"""OAuth connect/callback routes (app/api/oauth.py) -- the actual "Connect
X" flow. Uses the real LocalSecretStore default (writes small files under
.secretstore/, gitignored, same convention test_data_rights.py already
uses for LocalBlobStore rather than mocking it)."""

import httpx
import pytest

from app.api.oauth import get_http_client
from app.config import get_settings
from app.db.models import CalendarConnection, Org
from app.main import app
from app.oauth.flow import sign_state


@pytest.fixture(autouse=True)
def _oauth_env(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("VS_OAUTH_STATE_SECRET", "test-signing-secret")
    monkeypatch.setenv("VS_GOOGLE_OAUTH_CLIENT_ID", "google-cid")
    monkeypatch.setenv("VS_GOOGLE_OAUTH_CLIENT_SECRET", "google-csecret")
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


def test_callback_400s_for_a_provider_with_no_connection_upsert_wired_yet(client, db_session, monkeypatch):
    org = _seed_org(db_session)
    monkeypatch.setenv("VS_SLACK_OAUTH_CLIENT_ID", "slack-cid")
    monkeypatch.setenv("VS_SLACK_OAUTH_CLIENT_SECRET", "slack-csecret")
    get_settings.cache_clear()
    state = sign_state(org_id=org.id, provider="slack", secret="test-signing-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "at-1"})

    app.dependency_overrides[get_http_client] = _override_http_client(handler)
    try:
        resp = client.get(
            "/api/v1/oauth/slack/callback", params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code == 400
    assert "not wired up yet" in resp.json()["detail"]


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
    assert body[0]["account_email"] == "team@acme.test"
