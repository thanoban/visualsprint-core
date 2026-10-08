"""Tests for F14 pilot flag and capture-minute limit enforcement."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.auth import dependency as auth_dep
from app.capture.requests import CaptureMinuteLimitError, create_capture_request
from app.db.models import (
    CaptureRequest,
    Meeting,
    Org,
    OrgMember,
    UsageReservation,
    UsageReservationStatus,
    User,
)
from app.interfaces.capture_provider import MeetingTarget
from app.main import app

USER_OWNER = "55555555-5555-5555-5555-555555555551"
USER_MEMBER = "55555555-5555-5555-5555-555555555552"


def _seed(db, capture_monthly_minutes: int = 6000):
    db.add_all(
        [
            User(id=USER_OWNER, email="owner@example.com"),
            User(id=USER_MEMBER, email="member@example.com"),
        ]
    )
    db.flush()
    org = Org(
        name="PilotOrg",
        capture_policy="manual",
        capture_monthly_minutes=capture_monthly_minutes,
    )
    # Acknowledge disclosure so capture is enabled
    org.disclosure_ack_at = datetime.now(UTC)
    org.disclosure_ack_by = USER_OWNER
    db.add(org)
    db.flush()
    db.add_all(
        [
            OrgMember(org_id=org.id, user_id=USER_OWNER, role="owner"),
            OrgMember(org_id=org.id, user_id=USER_MEMBER, role="member"),
        ]
    )
    db.flush()
    return org


def _as(user_id: str) -> None:
    app.dependency_overrides[auth_dep.get_current_user] = lambda: User(id=user_id, email="x@y.com")


# ---------------------------------------------------------------------------
# Pilot flag
# ---------------------------------------------------------------------------


def test_get_pilot_flag_default_false(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_OWNER)

    resp = client.get(f"/api/v2/workspaces/{org.id}/pilot")
    assert resp.status_code == 200, resp.text
    assert resp.json()["pilot_features_enabled"] is False
    assert resp.json()["org_id"] == org.id


def test_enable_pilot_owner(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_OWNER)

    resp = client.patch(
        f"/api/v2/workspaces/{org.id}/pilot",
        json={"pilot_features_enabled": True},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["pilot_features_enabled"] is True


def test_enable_pilot_member_403(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_MEMBER)

    resp = client.patch(
        f"/api/v2/workspaces/{org.id}/pilot",
        json={"pilot_features_enabled": True},
    )
    assert resp.status_code == 403


def test_disable_pilot(client, db_session):
    org = _seed(db_session)
    org.pilot_features_enabled = True
    db_session.commit()
    _as(USER_OWNER)

    resp = client.patch(
        f"/api/v2/workspaces/{org.id}/pilot",
        json={"pilot_features_enabled": False},
    )
    assert resp.status_code == 200
    assert resp.json()["pilot_features_enabled"] is False


# ---------------------------------------------------------------------------
# Capture-minute limit enforcement (unit test via service function)
# ---------------------------------------------------------------------------


def _make_meeting(db, org_id: str) -> Meeting:
    m = Meeting(org_id=org_id, title="Test", platform="zoom")
    db.add(m)
    db.flush()
    return m


def _existing_request(db, org_id: str, meeting_id: str) -> CaptureRequest:
    request = CaptureRequest(
        org_id=org_id,
        meeting_id=meeting_id,
        requested_by=USER_OWNER,
        platform="zoom",
        native_meeting_id="123456789",
        meeting_url_secret_ref="capture-url/fake/existing",
        policy_snapshot={},
        input_hash="a" * 64,
        idempotency_key="existing-reservation",
    )
    db.add(request)
    db.flush()
    return request


def test_capture_limit_not_exceeded(db_session):
    org = _seed(db_session, capture_monthly_minutes=60)  # 3600 seconds
    meeting = _make_meeting(db_session, org.id)
    db_session.flush()

    # No existing reservations; 1800 seconds < 3600 limit → should succeed
    target = MeetingTarget(
        platform="zoom",
        native_meeting_id="123456789",
        meeting_url="https://us02web.zoom.us/j/123456789",
        passcode=None,
        requires_host_admission=None,
    )
    result = create_capture_request(
        db_session,
        org_id=org.id,
        meeting_id=meeting.id,
        requested_by=USER_OWNER,
        idempotency_key="key-limit-ok",
        target=target,
        meeting_url_secret_ref="capture-url/fake/hash",
        policy_snapshot={},
        estimated_seconds=1800,
    )
    assert result.created is True


def test_capture_limit_exceeded_raises(db_session):
    org = _seed(db_session, capture_monthly_minutes=1)  # 60 seconds
    meeting = _make_meeting(db_session, org.id)
    db_session.flush()

    # Add an existing reservation that fills the minute
    db_session.add(
        UsageReservation(
            org_id=org.id,
            request_id=_existing_request(db_session, org.id, meeting.id).id,
            unit="bot_second",
            estimated_quantity=Decimal("60"),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            status=UsageReservationStatus.RESERVED,
        )
    )
    db_session.flush()

    target = MeetingTarget(
        platform="zoom",
        native_meeting_id="987654321",
        meeting_url="https://us02web.zoom.us/j/987654321",
        passcode=None,
        requires_host_admission=None,
    )
    with pytest.raises(CaptureMinuteLimitError):
        create_capture_request(
            db_session,
            org_id=org.id,
            meeting_id=meeting.id,
            requested_by=USER_OWNER,
            idempotency_key="key-over-limit",
            target=target,
            meeting_url_secret_ref="capture-url/fake/hash2",
            policy_snapshot={},
            estimated_seconds=1,
        )


def test_capture_limit_previous_month_not_counted(db_session):
    org = _seed(db_session, capture_monthly_minutes=1)  # 60 seconds
    meeting = _make_meeting(db_session, org.id)
    db_session.flush()

    # Add a reservation from last month — should not count toward current limit
    last_month = datetime.now(UTC).replace(day=1) - timedelta(days=1)
    reservation = UsageReservation(
        org_id=org.id,
        request_id=_existing_request(db_session, org.id, meeting.id).id,
        unit="bot_second",
        estimated_quantity=Decimal("3600"),
        expires_at=datetime.now(UTC) + timedelta(hours=1),
        status=UsageReservationStatus.RESERVED,
    )
    db_session.add(reservation)
    db_session.flush()
    # Backdate via direct update
    reservation.created_at = last_month
    db_session.flush()

    target = MeetingTarget(
        platform="zoom",
        native_meeting_id="111111111",
        meeting_url="https://us02web.zoom.us/j/111111111",
        passcode=None,
        requires_host_admission=None,
    )
    # 30 seconds < 60-second limit; previous month's hours don't count
    result = create_capture_request(
        db_session,
        org_id=org.id,
        meeting_id=meeting.id,
        requested_by=USER_OWNER,
        idempotency_key="key-prev-month",
        target=target,
        meeting_url_secret_ref="capture-url/fake/hash3",
        policy_snapshot={},
        estimated_seconds=30,
    )
    assert result.created is True
