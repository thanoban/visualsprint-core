from datetime import UTC, datetime

from app.db.models import (
    BotSession,
    BotStatus,
    CaptureSession,
    CaptureState,
    CoverageInterval,
    CoverageStatus,
    Meeting,
    Org,
)


def test_list_meetings_returns_latest_capture_and_gap_state(client, db_session):
    org = Org(name="acme")
    db_session.add(org)
    db_session.flush()

    older = Meeting(
        org_id=org.id,
        title="Older sync",
        platform="meet",
        scheduled_start=datetime(2026, 8, 20, 9, 0, tzinfo=UTC),
    )
    newer = Meeting(
        org_id=org.id,
        title="Weekly review",
        platform="zoom",
        scheduled_start=datetime(2026, 8, 24, 15, 0, tzinfo=UTC),
    )
    db_session.add_all([older, newer])
    db_session.flush()

    old_session = CaptureSession(org_id=org.id, meeting_id=newer.id, mode="A2", state=CaptureState.FAILED)
    latest_session = CaptureSession(
        org_id=org.id,
        meeting_id=newer.id,
        mode="B",
        state=CaptureState.REPORTING,
        error="still processing",
    )
    db_session.add_all([old_session, latest_session])
    db_session.flush()

    db_session.add(
        CoverageInterval(
            org_id=org.id,
            capture_session_id=latest_session.id,
            start_s=1.0,
            end_s=4.0,
            modality="screen",
            status=CoverageStatus.MISSING,
            reason="bot screen dropped",
        )
    )
    db_session.add(
        BotSession(
            org_id=org.id,
            meeting_id=newer.id,
            platform="zoom",
            join_url="https://zoom.us/j/123",
            status=BotStatus.LIVE,
        )
    )
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{org.id}/meetings")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert [row["title"] for row in body] == ["Weekly review", "Older sync"]
    assert body[0]["latest_capture_session_id"] == latest_session.id
    assert body[0]["latest_capture_mode"] == "B"
    assert body[0]["latest_capture_state"] == "reporting"
    assert body[0]["latest_capture_error"] == "still processing"
    assert body[0]["latest_bot_status"] == "live"
    assert body[0]["has_coverage_gap"] is True
    assert body[1]["latest_capture_session_id"] is None
    assert body[1]["has_coverage_gap"] is False


def test_list_meetings_404s_for_unknown_org(client):
    resp = client.get("/api/v1/orgs/does-not-exist/meetings")
    assert resp.status_code == 404
