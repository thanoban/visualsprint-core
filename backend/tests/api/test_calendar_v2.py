"""Tests for calendar occurrence list and capture-override API (F03)."""

from datetime import UTC, datetime, timedelta

from app.db.models import (
    CalendarConnection,
    CalendarOccurrence,
    CalendarOccurrenceStatus,
    Org,
    OrgMember,
    User,
)

USER_ID = "test-user-0000-0000-0000-000000000000"


def seed(db):
    org = Org(name="Acme", capture_policy="calendar")
    db.add(org)
    db.flush()
    db.add(User(id=USER_ID, email="founder@example.com"))
    db.add(OrgMember(org_id=org.id, user_id=USER_ID, role="owner"))
    connection = CalendarConnection(
        org_id=org.id, provider="google", account_email="founder@example.com", secret_ref="ref"
    )
    db.add(connection)
    db.commit()
    return org, connection


def _occurrence(db, org, connection, *, minutes_from_now=60, event_id="evt-1"):
    start = datetime.now(UTC) + timedelta(minutes=minutes_from_now)
    occ = CalendarOccurrence(
        org_id=org.id,
        connection_id=connection.id,
        provider_event_id=event_id,
        original_start=start,
        start_time=start,
        end_time=start + timedelta(minutes=30),
        title="Stand-up",
        platform="meet",
        status=CalendarOccurrenceStatus.SCHEDULED,
    )
    db.add(occ)
    db.commit()
    return occ


def test_list_occurrences_returns_upcoming_non_cancelled(client, db_session):
    org, connection = seed(db_session)
    _occurrence(db_session, org, connection, minutes_from_now=60, event_id="evt-1")
    cancelled = _occurrence(db_session, org, connection, minutes_from_now=120, event_id="evt-2")
    cancelled.status = CalendarOccurrenceStatus.CANCELLED
    db_session.commit()

    response = client.get(f"/api/v2/workspaces/{org.id}/occurrences")
    assert response.status_code == 200
    ids = [o["provider_event_id"] for o in response.json()]
    assert "evt-1" in ids
    assert "evt-2" not in ids


def test_list_occurrences_respects_days_window(client, db_session):
    org, connection = seed(db_session)
    _occurrence(db_session, org, connection, minutes_from_now=60, event_id="near")
    _occurrence(db_session, org, connection, minutes_from_now=60 * 24 * 10, event_id="far")

    response = client.get(f"/api/v2/workspaces/{org.id}/occurrences?days=1")
    assert response.status_code == 200
    ids = [o["provider_event_id"] for o in response.json()]
    assert "near" in ids
    assert "far" not in ids


def test_list_occurrences_rejects_invalid_days(client, db_session):
    org, _ = seed(db_session)
    assert client.get(f"/api/v2/workspaces/{org.id}/occurrences?days=0").status_code == 422
    assert client.get(f"/api/v2/workspaces/{org.id}/occurrences?days=91").status_code == 422


def test_set_capture_override_on_and_off(client, db_session):
    org, connection = seed(db_session)
    occ = _occurrence(db_session, org, connection)

    url = f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/capture-override"
    resp = client.patch(url, json={"capture_override": "on"})
    assert resp.status_code == 200
    assert resp.json()["capture_override"] == "on"

    resp = client.patch(url, json={"capture_override": "off"})
    assert resp.status_code == 200
    assert resp.json()["capture_override"] == "off"

    resp = client.patch(url, json={"capture_override": None})
    assert resp.status_code == 200
    assert resp.json()["capture_override"] is None


def test_set_capture_override_rejects_invalid_value(client, db_session):
    org, connection = seed(db_session)
    occ = _occurrence(db_session, org, connection)
    url = f"/api/v2/workspaces/{org.id}/occurrences/{occ.id}/capture-override"
    assert client.patch(url, json={"capture_override": "maybe"}).status_code == 422


def test_set_capture_override_returns_404_for_unknown_occurrence(client, db_session):
    org, _ = seed(db_session)
    url = f"/api/v2/workspaces/{org.id}/occurrences/does-not-exist/capture-override"
    assert client.patch(url, json={"capture_override": "on"}).status_code == 404


def test_list_calendar_connections_shows_health(client, db_session):
    org, connection = seed(db_session)
    response = client.get(f"/api/v2/workspaces/{org.id}/connections")
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["provider"] == "google"
    assert response.json()[0]["account_email"] == "founder@example.com"
    assert response.json()[0]["watch_healthy"] is False
