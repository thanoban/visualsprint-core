from app.db.models import LandingLead


def test_create_demo_lead_persists_row(client, db_session):
    resp = client.post(
        "/api/v1/leads",
        json={
            "kind": "demo",
            "name": "Nimal Perera",
            "email": "nimal@acme.test",
            "company": "Acme Labs",
            "message": "Interested in the Sinhala/Tamil capture.",
        },
    )
    assert resp.status_code == 201
    lead_id = resp.json()["id"]

    lead = db_session.get(LandingLead, lead_id)
    assert lead is not None
    assert lead.kind.value == "demo"
    assert lead.name == "Nimal Perera"
    assert lead.email == "nimal@acme.test"
    assert lead.company == "Acme Labs"


def test_create_collaborate_lead_without_optional_fields(client):
    resp = client.post(
        "/api/v1/leads",
        json={"kind": "collaborate", "name": "Ayesha F.", "email": "ayesha@acme.test"},
    )
    assert resp.status_code == 201


def test_rejects_invalid_email(client):
    resp = client.post(
        "/api/v1/leads",
        json={"kind": "demo", "name": "Nimal", "email": "not-an-email"},
    )
    assert resp.status_code == 422


def test_rejects_blank_name(client):
    resp = client.post(
        "/api/v1/leads",
        json={"kind": "demo", "name": "  ", "email": "nimal@acme.test"},
    )
    assert resp.status_code == 422


def test_rejects_unknown_kind(client):
    resp = client.post(
        "/api/v1/leads",
        json={"kind": "sales", "name": "Nimal", "email": "nimal@acme.test"},
    )
    assert resp.status_code == 422


def test_does_not_require_authentication(client, monkeypatch):
    """The whole point of this endpoint -- anonymous marketing-site visitors
    have no account yet. Break get_current_user to prove auth is never
    consulted on this path."""
    from app.auth import dependency as auth_dep

    def _boom():
        raise AssertionError("leads endpoint must not require authentication")

    from app.main import app

    app.dependency_overrides[auth_dep.get_current_user] = _boom
    try:
        resp = client.post(
            "/api/v1/leads",
            json={"kind": "demo", "name": "Nimal", "email": "nimal@acme.test"},
        )
        assert resp.status_code == 201
    finally:
        app.dependency_overrides.pop(auth_dep.get_current_user, None)
