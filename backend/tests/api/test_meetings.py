from datetime import UTC, datetime

from app.db.models import (
    BotSession,
    BotStatus,
    CaptureRequest,
    CaptureRequestStatus,
    CaptureSession,
    CaptureState,
    CoverageInterval,
    CoverageStatus,
    Meeting,
    Org,
    User,
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


def test_list_meetings_surfaces_capture_request_status(client, db_session):
    org = Org(name="acme2")
    db_session.add(org)
    db_session.flush()
    user = User(id="u-2", email="x@example.com")
    db_session.add(user)
    db_session.flush()
    meeting = Meeting(org_id=org.id, title="Standup", platform="meet")
    db_session.add(meeting)
    db_session.flush()

    req = CaptureRequest(
        org_id=org.id,
        meeting_id=meeting.id,
        requested_by=user.id,
        platform="google_meet",
        native_meeting_id="aaa-bbbb-ccc",
        meeting_url_secret_ref="s",
        policy_snapshot={},
        input_hash="a" * 64,
        idempotency_key="key-standup",
        status=CaptureRequestStatus.FINALIZED,
    )
    db_session.add(req)
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{org.id}/meetings")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    assert body[0]["latest_capture_request_id"] == req.id
    assert body[0]["latest_capture_request_status"] == "finalized"


def test_list_meetings_report_ready_flag(client, db_session):
    org = Org(name="acme3")
    db_session.add(org)
    db_session.flush()
    meeting = Meeting(org_id=org.id, title="Done meeting", platform="meet")
    db_session.add(meeting)
    db_session.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="B", state=CaptureState.DONE)
    db_session.add(session)
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{org.id}/meetings")
    assert resp.status_code == 200, resp.text
    assert resp.json()[0]["report_ready"] is True


def test_get_capture_status_returns_processing_state(client, db_session):
    org = Org(name="acme4")
    db_session.add(org)
    db_session.flush()
    meeting = Meeting(org_id=org.id, title="Processing meeting", platform="teams")
    db_session.add(meeting)
    db_session.flush()
    session = CaptureSession(
        org_id=org.id,
        meeting_id=meeting.id,
        mode="B",
        state=CaptureState.UNDERSTANDING,
    )
    db_session.add(session)
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{org.id}/meetings/{meeting.id}/capture-status")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "understanding"
    assert body["report_ready"] is False
    assert body["pipeline_progress_pct"] > 0
    assert body["pipeline_progress_pct"] < 100


def test_get_capture_status_done_means_report_ready(client, db_session):
    org = Org(name="acme5")
    db_session.add(org)
    db_session.flush()
    meeting = Meeting(org_id=org.id, title="Done", platform="meet")
    db_session.add(meeting)
    db_session.flush()
    session = CaptureSession(
        org_id=org.id,
        meeting_id=meeting.id,
        mode="B",
        state=CaptureState.DONE,
        report_title="Weekly sync summary",
        report_summary="Discussed Q4 plans.",
    )
    db_session.add(session)
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{org.id}/meetings/{meeting.id}/capture-status")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["report_ready"] is True
    assert body["pipeline_progress_pct"] == 100
    assert body["report_title"] == "Weekly sync summary"
    assert body["report_summary"] == "Discussed Q4 plans."


def test_get_capture_status_404_when_no_session(client, db_session):
    org = Org(name="acme6")
    db_session.add(org)
    db_session.flush()
    meeting = Meeting(org_id=org.id, title="No capture", platform="meet")
    db_session.add(meeting)
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{org.id}/meetings/{meeting.id}/capture-status")
    assert resp.status_code == 404


def test_get_capture_status_with_coverage_gap(client, db_session):
    org = Org(name="acme7")
    db_session.add(org)
    db_session.flush()
    meeting = Meeting(org_id=org.id, title="Gap meeting", platform="meet")
    db_session.add(meeting)
    db_session.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="B", state=CaptureState.DONE)
    db_session.add(session)
    db_session.flush()
    db_session.add(
        CoverageInterval(
            org_id=org.id,
            capture_session_id=session.id,
            start_s=10.0,
            end_s=15.0,
            modality="audio",
            status=CoverageStatus.MISSING,
            reason="silence gap",
        )
    )
    db_session.commit()

    resp = client.get(f"/api/v1/orgs/{org.id}/meetings/{meeting.id}/capture-status")
    assert resp.status_code == 200, resp.text
    assert resp.json()["has_coverage_gap"] is True
