from types import SimpleNamespace

from app.api import capture
from app.db.models import BotSession, BotStatus, Meeting, Org, OrgConnection, User


def _seed_org(db) -> Org:
    if db.get(User, "11111111-1111-1111-1111-111111111111") is None:
        db.add(User(id="11111111-1111-1111-1111-111111111111", email="test@example.com"))
    org = Org(name="acme")
    db.add(org)
    db.flush()
    return org


def test_instant_capture_zoom_dispatches_nothing(client, db_session):
    org = _seed_org(db_session)
    db_session.commit()

    resp = client.post(
        f"/api/v1/orgs/{org.id}/capture/instant",
        json={"url": "https://us02web.zoom.us/j/123456789"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["platform"] == "zoom"
    assert body["dispatched"] is False
    assert body["bot_session_id"] is None
    assert body["capture_mode"] == "C"
    assert body["status"] == "action_required"
    assert db_session.query(BotSession).count() == 0


def test_instant_capture_meet_requires_explicit_guest_bot_opt_in(client, db_session):
    org = _seed_org(db_session)
    db_session.commit()

    resp = client.post(
        f"/api/v1/orgs/{org.id}/capture/instant",
        json={"url": "https://meet.google.com/abc-defg-hij", "title": "Ad hoc sync"},
    )
    assert resp.status_code == 200
    assert resp.json()["capture_mode"] == "C"
    assert "Companion" in resp.json()["note"]
    assert db_session.query(BotSession).count() == 0


def test_instant_capture_meet_creates_bot_when_explicitly_enabled(client, db_session, monkeypatch):
    monkeypatch.setattr(
        capture,
        "get_settings",
        lambda: SimpleNamespace(
            bot_google_guest_enabled=True,
            bot_dispatch_enabled=True,
            bot_google_join_mode="guest",
            bot_google_account_email=None,
        ),
    )
    org = _seed_org(db_session)
    db_session.commit()

    resp = client.post(
        f"/api/v1/orgs/{org.id}/capture/instant",
        json={"url": "https://meet.google.com/abc-defg-hij", "title": "Ad hoc sync"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["platform"] == "meet"
    assert body["meeting_id"] is not None
    assert body["bot_session_id"] is not None

    meeting = db_session.get(Meeting, body["meeting_id"])
    assert meeting is not None
    assert meeting.platform == "meet"
    assert meeting.title == "Ad hoc sync"

    bot = db_session.get(BotSession, body["bot_session_id"])
    assert bot is not None
    assert bot.status == BotStatus.SCHEDULED
    assert bot.join_url == "https://meet.google.com/abc-defg-hij"
    assert bot.scheduled_start is not None


def test_instant_capture_teams_join_url_is_the_full_link(client, db_session, monkeypatch):
    monkeypatch.setattr(capture, "get_settings", lambda: SimpleNamespace(
        bot_google_guest_enabled=False, bot_teams_guest_enabled=True, bot_dispatch_enabled=True,
        bot_google_join_mode="guest", bot_google_account_email=None,
    ))
    org = _seed_org(db_session)
    db_session.commit()

    teams_url = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"
    resp = client.post(
        f"/api/v1/orgs/{org.id}/capture/instant",
        json={"url": teams_url},
    )
    assert resp.status_code == 200
    body = resp.json()
    bot = db_session.get(BotSession, body["bot_session_id"])
    assert bot.join_url == teams_url


def test_zoom_connection_does_not_claim_live_capture(client, db_session):
    org = _seed_org(db_session)
    db_session.add(OrgConnection(org_id=org.id, provider="zoom", account_label="host",
                                 secret_ref="test/zoom"))
    db_session.commit()
    result = client.post(f"/api/v1/orgs/{org.id}/capture/instant",
                         json={"url": "https://zoom.us/j/123456789"}).json()
    assert result["capture_mode"] == "A1"
    assert result["status"] == "awaiting_stream"
    assert "does not confirm" in result["note"]


def test_instant_capture_unrecognized_url_is_422(client, db_session):
    org = _seed_org(db_session)
    db_session.commit()

    resp = client.post(
        f"/api/v1/orgs/{org.id}/capture/instant",
        json={"url": "https://example.com/not-a-meeting"},
    )
    assert resp.status_code == 422


def test_get_bot_session_status_returns_current_state(client, db_session):
    org = _seed_org(db_session)
    db_session.commit()

    meeting = Meeting(org_id=org.id, platform="meet", title="Scheduled")
    db_session.add(meeting)
    db_session.flush()
    bot = BotSession(
        org_id=org.id,
        meeting_id=meeting.id,
        platform="meet",
        join_url="https://meet.google.com/abc-defg-hij",
    )
    db_session.add(bot)
    db_session.commit()
    bot_session_id = bot.id

    # Poll the status endpoint
    status_resp = client.get(f"/api/v1/orgs/{org.id}/capture/sessions/{bot_session_id}")
    assert status_resp.status_code == 200
    body = status_resp.json()
    assert body["id"] == bot_session_id
    assert body["status"] == "scheduled"
    assert body["platform"] == "meet"
    assert body["error"] is None
    assert body["capture_session_id"] is None


def test_get_bot_session_status_wrong_org_is_404(client, db_session):
    org_a = _seed_org(db_session)
    org_b = Org(name="other")
    db_session.add(org_b)
    db_session.commit()

    meeting = Meeting(org_id=org_a.id, platform="meet", title="Scheduled")
    db_session.add(meeting)
    db_session.flush()
    bot = BotSession(
        org_id=org_a.id,
        meeting_id=meeting.id,
        platform="meet",
        join_url="https://meet.google.com/abc-defg-hij",
    )
    db_session.add(bot)
    db_session.commit()
    bot_session_id = bot.id

    # Querying with org_b should 404 (cross-tenant isolation)
    status_resp = client.get(f"/api/v1/orgs/{org_b.id}/capture/sessions/{bot_session_id}")
    assert status_resp.status_code == 404
