"""Tests for F11 agenda endpoints."""

from datetime import UTC, datetime

from app.auth import dependency as auth_dep
from app.db.models import (
    AgendaVersion,
    CalendarConnection,
    CalendarOccurrence,
    CalendarOccurrenceStatus,
    Org,
    OrgMember,
    User,
)
from app.main import app

USER_1 = "agd-user-0000-0000-0000-000000000001"


def _seed(db):
    org = Org(name="AgendaOrg")
    db.add(org)
    db.flush()
    db.add(User(id=USER_1, email="founder@example.com"))
    db.flush()
    db.add(OrgMember(org_id=org.id, user_id=USER_1, role="owner"))
    db.commit()
    return org


def _as(user_id, email):
    app.dependency_overrides[auth_dep.get_current_user] = lambda: User(id=user_id, email=email)


def _make_occurrence(db, org_id, title="Weekly sync"):
    conn = CalendarConnection(
        org_id=org_id,
        provider="google",
        account_email="user@example.com",
        secret_ref="ref",
        watch_expires_at=None,
    )
    db.add(conn)
    db.flush()
    occ = CalendarOccurrence(
        org_id=org_id,
        connection_id=conn.id,
        provider_event_id="event-001",
        original_start=datetime(2026, 10, 20, 10, 0, tzinfo=UTC),
        start_time=datetime(2026, 10, 20, 10, 0, tzinfo=UTC),
        end_time=datetime(2026, 10, 20, 11, 0, tzinfo=UTC),
        title=title,
        status=CalendarOccurrenceStatus.SCHEDULED,
    )
    db.add(occ)
    db.flush()
    return occ


def test_generate_agenda_returns_sections(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    occ = _make_occurrence(db_session, org.id, "Q4 Planning")
    db_session.commit()

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda",
        json={"objective": "Finalize Q4 goals"},
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["occurrence_id"] == occ.id
    assert body["version"] == 1
    assert isinstance(body["sections"], list)
    assert len(body["sections"]) > 0
    assert body["objective"] == "Finalize Q4 goals"
    # Objective section present
    headings = [s["heading"] for s in body["sections"]]
    assert "Objective" in headings


def test_generate_agenda_idempotent(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    occ = _make_occurrence(db_session, org.id)
    db_session.commit()

    resp1 = client.post(
        f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda",
        json={"objective": ""},
    )
    resp2 = client.post(
        f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda",
        json={"objective": ""},
    )
    assert resp1.status_code == 202
    assert resp2.status_code == 202
    assert resp1.json()["id"] == resp2.json()["id"]
    # Only one row in DB
    assert db_session.query(AgendaVersion).filter_by(occurrence_id=occ.id).count() == 1


def test_generate_agenda_different_objective_creates_new_version(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    occ = _make_occurrence(db_session, org.id)
    db_session.commit()

    resp1 = client.post(
        f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda",
        json={"objective": "Objective A"},
    )
    resp2 = client.post(
        f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda",
        json={"objective": "Objective B"},
    )
    assert resp1.json()["id"] != resp2.json()["id"]
    assert db_session.query(AgendaVersion).filter_by(occurrence_id=occ.id).count() == 2


def test_get_agenda_returns_latest(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    occ = _make_occurrence(db_session, org.id)
    db_session.commit()

    client.post(
        f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda",
        json={"objective": "First"},
    )

    resp = client.get(f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda")
    assert resp.status_code == 200, resp.text
    assert resp.json()["objective"] == "First"


def test_get_agenda_404_when_none_generated(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    occ = _make_occurrence(db_session, org.id)
    db_session.commit()

    resp = client.get(f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda")
    assert resp.status_code == 404


def test_update_agenda_saves_edits(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    occ = _make_occurrence(db_session, org.id)
    db_session.commit()

    generated = client.post(
        f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda",
        json={"objective": ""},
    ).json()

    updated = client.patch(
        f"/api/v2/workspaces/{org.id}/agendas/{generated['id']}",
        json={
            "version": 1,
            "sections": [
                {"heading": "Custom section", "notes": "My notes"},
                {"heading": "Next steps", "notes": ""},
            ],
            "objective": "Updated goal",
        },
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["version"] == 2
    assert body["edited_by"] == USER_1
    assert body["sections"][0]["heading"] == "Custom section"
    assert body["objective"] == "Updated goal"


def test_update_agenda_version_conflict(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    occ = _make_occurrence(db_session, org.id)
    db_session.commit()

    generated = client.post(
        f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/agenda",
        json={"objective": ""},
    ).json()

    client.patch(
        f"/api/v2/workspaces/{org.id}/agendas/{generated['id']}",
        json={"version": 1, "sections": [{"heading": "First", "notes": ""}]},
    )
    stale = client.patch(
        f"/api/v2/workspaces/{org.id}/agendas/{generated['id']}",
        json={"version": 1, "sections": [{"heading": "Stale", "notes": ""}]},
    )
    assert stale.status_code == 409


def test_generate_agenda_unknown_occurrence_is_404(client, db_session):
    org = _seed(db_session)
    _as(USER_1, "founder@example.com")
    db_session.commit()

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/occurrences/does-not-exist/agenda",
        json={"objective": ""},
    )
    assert resp.status_code == 404
