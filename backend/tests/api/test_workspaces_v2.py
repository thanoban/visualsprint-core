from app.db.models import Org, OrgMember, User

USER_ID = "test-user-0000-0000-0000-000000000000"


def seed(db, role="owner"):
    org = Org(name="Founder workspace")
    db.add(org)
    db.flush()
    db.add(User(id=USER_ID, email="founder@example.com"))
    db.add(OrgMember(org_id=org.id, user_id=USER_ID, role=role))
    db.commit()
    return org


def test_workspace_defaults_capture_off_until_acknowledged(client, db_session):
    org = seed(db_session)
    response = client.get(f"/api/v2/workspaces/{org.id}")
    assert response.status_code == 200
    assert response.json()["capture_policy"] == "off"
    assert response.json()["disclosure_acknowledged"] is False
    assert response.json()["onboarding_complete"] is False
    assert response.json()["capture_concurrency_limit"] == 5
    assert response.json()["capture_monthly_minutes"] == 6000


def test_owner_must_acknowledge_disclosure_before_enabling_capture(client, db_session):
    org = seed(db_session)
    url = f"/api/v2/workspaces/{org.id}"
    denied = client.patch(url, json={"capture_policy": "manual"})
    assert denied.status_code == 409

    enabled = client.patch(
        url,
        json={
            "capture_policy": "manual",
            "acknowledge_disclosure": True,
            "timezone": "Asia/Colombo",
            "preferred_language": "en",
        },
    )
    assert enabled.status_code == 200
    assert enabled.json()["onboarding_complete"] is True
    assert enabled.json()["timezone"] == "Asia/Colombo"
    db_session.refresh(org)
    assert org.disclosure_ack_by == USER_ID


def test_regular_member_can_read_but_cannot_change_workspace_policy(client, db_session):
    org = seed(db_session, role="member")
    assert client.get(f"/api/v2/workspaces/{org.id}").status_code == 200
    response = client.patch(
        f"/api/v2/workspaces/{org.id}",
        json={"capture_policy": "manual", "acknowledge_disclosure": True},
    )
    assert response.status_code == 403


def test_invalid_timezone_language_and_limits_are_rejected(client, db_session):
    org = seed(db_session)
    url = f"/api/v2/workspaces/{org.id}"
    assert client.patch(url, json={"timezone": "Mars/Olympus"}).status_code == 422
    assert client.patch(url, json={"preferred_language": "ta"}).status_code == 422
    assert client.patch(url, json={"capture_concurrency_limit": 6}).status_code == 422
    assert client.patch(url, json={"capture_monthly_minutes": 6001}).status_code == 422
