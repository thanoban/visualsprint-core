"""app/oauth/connection.py -- the shared per-org OAuth connection lookup
used by actions.py, worker.py's calendar sync, and worker.py's Mode A2
platform-adapter construction."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.capture.oauth_token_provider import OAuthTokenProvider
from app.config import get_settings
from app.db.base import Base
from app.db.models import CalendarConnection, Org, OrgConnection
from app.oauth.connection import build_org_token_provider, get_org_connection


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _org(db) -> Org:
    org = Org(name="acme")
    db.add(org)
    db.commit()
    return org


def test_get_org_connection_looks_in_calendar_connection_for_google(db):
    org = _org(db)
    db.add(
        CalendarConnection(
            org_id=org.id, provider="google", account_email="a@acme.test", secret_ref="oauth/google/x"
        )
    )
    db.commit()

    connection = get_org_connection(db, org.id, "google")

    assert isinstance(connection, CalendarConnection)


def test_get_org_connection_looks_in_calendar_connection_for_microsoft(db):
    org = _org(db)
    db.add(
        CalendarConnection(
            org_id=org.id, provider="microsoft", account_email="a@acme.test", secret_ref="oauth/microsoft/x"
        )
    )
    db.commit()

    connection = get_org_connection(db, org.id, "microsoft")

    assert isinstance(connection, CalendarConnection)


def test_get_org_connection_looks_in_org_connection_for_everything_else(db):
    org = _org(db)
    db.add(
        OrgConnection(
            org_id=org.id, provider="slack", account_label="Acme", secret_ref="oauth/slack/x"
        )
    )
    db.commit()

    connection = get_org_connection(db, org.id, "slack")

    assert isinstance(connection, OrgConnection)


def test_get_org_connection_returns_none_when_not_connected(db):
    org = _org(db)
    assert get_org_connection(db, org.id, "zoom") is None


def test_build_org_token_provider_returns_none_when_not_connected(db):
    org = _org(db)
    assert build_org_token_provider(db, org.id, "google") is None


def test_build_org_token_provider_returns_none_when_app_oauth_client_not_configured(
    db, monkeypatch
):
    org = _org(db)
    db.add(
        CalendarConnection(
            org_id=org.id, provider="google", account_email="a@acme.test", secret_ref="oauth/google/x"
        )
    )
    db.commit()
    monkeypatch.delenv("VS_GOOGLE_OAUTH_CLIENT_ID", raising=False)
    get_settings.cache_clear()

    try:
        provider = build_org_token_provider(db, org.id, "google")
    finally:
        get_settings.cache_clear()

    assert provider is None


def test_build_org_token_provider_returns_a_real_provider_when_connected_and_configured(
    db, monkeypatch
):
    org = _org(db)
    db.add(
        OrgConnection(
            org_id=org.id, provider="zoom", account_label="ops@acme.test", external_id="zoom-acc",
            secret_ref="oauth/zoom/x",
        )
    )
    db.commit()
    monkeypatch.setenv("VS_ZOOM_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("VS_ZOOM_OAUTH_CLIENT_SECRET", "csecret")
    get_settings.cache_clear()

    try:
        provider = build_org_token_provider(db, org.id, "zoom")
    finally:
        get_settings.cache_clear()

    assert isinstance(provider, OAuthTokenProvider)
    assert provider._secret_ref == "oauth/zoom/x"


def test_two_orgs_get_providers_bound_to_their_own_connections(db, monkeypatch):
    org_a = Org(name="org-a")
    org_b = Org(name="org-b")
    db.add_all([org_a, org_b])
    db.flush()
    db.add(
        OrgConnection(org_id=org_a.id, provider="slack", account_label="A", secret_ref="oauth/slack/a")
    )
    db.add(
        OrgConnection(org_id=org_b.id, provider="slack", account_label="B", secret_ref="oauth/slack/b")
    )
    db.commit()
    monkeypatch.setenv("VS_SLACK_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("VS_SLACK_OAUTH_CLIENT_SECRET", "csecret")
    get_settings.cache_clear()

    try:
        provider_a = build_org_token_provider(db, org_a.id, "slack")
        provider_b = build_org_token_provider(db, org_b.id, "slack")
    finally:
        get_settings.cache_clear()

    assert provider_a._secret_ref == "oauth/slack/a"
    assert provider_b._secret_ref == "oauth/slack/b"
