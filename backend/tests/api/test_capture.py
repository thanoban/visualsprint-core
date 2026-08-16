from app.db.models import BotSession, BotStatus, Meeting, Org


def _seed_org(db) -> Org:
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
    assert "automatically" in body["note"]
    assert db_session.query(BotSession).count() == 0


def test_instant_capture_meet_creates_scheduled_bot_session(client, db_session):
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


def test_instant_capture_teams_join_url_is_the_full_link(client, db_session):
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


def test_instant_capture_unrecognized_url_is_422(client, db_session):
    org = _seed_org(db_session)
    db_session.commit()

    resp = client.post(
        f"/api/v1/orgs/{org.id}/capture/instant",
        json={"url": "https://example.com/not-a-meeting"},
    )
    assert resp.status_code == 422
