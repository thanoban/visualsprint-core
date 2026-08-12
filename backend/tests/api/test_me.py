"""Tests for GET /api/v1/me (app/api/me.py) -- the replacement for the old
dev-convenience GET /orgs/default. Covers app.auth.dependency.get_current_user's
first-login auto-create (personal Org + OrgMember) and that a second login
from the same user reuses it rather than creating a duplicate.

Bypasses the real JWT verification entirely by overriding get_current_user
directly (same as every other test in tests/api/) -- app/auth/test_verify.py
already covers the JWT-parsing boundary itself.
"""

from app.auth.dependency import get_current_user
from app.db.models import Org, OrgMember, Person, User
from app.main import app


def test_first_login_creates_a_personal_org(client, db_session, monkeypatch):
    import app.auth.dependency as auth_dep

    monkeypatch.setattr(
        auth_dep, "verify_jwt", lambda token: {"sub": "user-abc", "email": "nimal@acme.com"}
    )
    app.dependency_overrides.pop(get_current_user, None)

    resp = client.get("/api/v1/me", headers={"Authorization": "Bearer whatever"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["user"]["id"] == "user-abc"
    assert body["user"]["email"] == "nimal@acme.com"
    assert body["org"]["name"] == "nimal@acme.com"

    user = db_session.get(User, "user-abc")
    assert user is not None
    member = db_session.query(OrgMember).filter(OrgMember.user_id == "user-abc").one()
    assert member.role == "owner"
    org = db_session.get(Org, member.org_id)
    assert org.id == body["org"]["id"]


def test_second_login_reuses_the_same_org(client, db_session, monkeypatch):
    import app.auth.dependency as auth_dep

    monkeypatch.setattr(
        auth_dep, "verify_jwt", lambda token: {"sub": "user-abc", "email": "nimal@acme.com"}
    )
    app.dependency_overrides.pop(get_current_user, None)

    first = client.get("/api/v1/me", headers={"Authorization": "Bearer t1"})
    second = client.get("/api/v1/me", headers={"Authorization": "Bearer t2"})

    assert first.json()["org"]["id"] == second.json()["org"]["id"]
    assert db_session.query(OrgMember).filter(OrgMember.user_id == "user-abc").count() == 1


def test_me_links_to_a_person_only_on_unique_email_match(client, db_session, monkeypatch):
    import app.auth.dependency as auth_dep

    monkeypatch.setattr(
        auth_dep, "verify_jwt", lambda token: {"sub": "user-abc", "email": "nimal@acme.com"}
    )
    app.dependency_overrides.pop(get_current_user, None)

    first = client.get("/api/v1/me", headers={"Authorization": "Bearer t1"})
    org_id = first.json()["org"]["id"]
    person = Person(org_id=org_id, display_name="Nimal Perera", email="nimal@acme.com")
    db_session.add(person)
    db_session.commit()

    resp = client.get("/api/v1/me", headers={"Authorization": "Bearer t2"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["person"]["id"] == person.id
    assert db_session.get(Person, person.id).user_id == "user-abc"


def test_missing_authorization_header_is_401(client):
    app.dependency_overrides.pop(get_current_user, None)

    resp = client.get("/api/v1/me")

    assert resp.status_code in (401, 422)  # FastAPI 422s a missing required header


def test_malformed_authorization_header_is_401(client):
    app.dependency_overrides.pop(get_current_user, None)

    resp = client.get("/api/v1/me", headers={"Authorization": "not-bearer-shaped"})

    assert resp.status_code == 401
