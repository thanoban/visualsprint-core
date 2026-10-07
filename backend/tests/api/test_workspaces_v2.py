from app.auth import dependency as auth_dep
from app.db.models import Org, OrgMember, User
from app.main import app

USER_ID = "test-user-0000-0000-0000-000000000000"
USER_2 = "22222222-2222-2222-2222-222222222222"


def seed(db, role="owner"):
    org = Org(name="Founder workspace")
    db.add(org)
    db.flush()
    db.add(User(id=USER_ID, email="founder@example.com"))
    db.add(OrgMember(org_id=org.id, user_id=USER_ID, role=role))
    db.commit()
    return org


def as_user(user_id, email):
    app.dependency_overrides[auth_dep.get_current_user] = lambda: User(id=user_id, email=email)


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


def test_owner_can_add_existing_user_and_list_members(client, db_session):
    org = seed(db_session)
    colleague = User(id=USER_2, email="colleague@example.com")
    db_session.add(colleague)
    db_session.commit()

    members_url = f"/api/v2/workspaces/{org.id}/members"
    listed = client.get(members_url)
    assert listed.status_code == 200
    assert len(listed.json()) == 1
    assert listed.json()[0]["email"] == "founder@example.com"

    added = client.post(members_url, json={"email": "Colleague@Example.COM", "role": "member"})
    assert added.status_code == 201
    assert added.json()["email"] == "colleague@example.com"
    assert added.json()["role"] == "member"
    assert added.json()["user_id"] == USER_2

    assert len(client.get(members_url).json()) == 2
    assert client.post(members_url, json={"email": "colleague@example.com"}).status_code == 409


def test_add_member_fails_for_unknown_email(client, db_session):
    org = seed(db_session)
    response = client.post(
        f"/api/v2/workspaces/{org.id}/members",
        json={"email": "nobody@example.com"},
    )
    assert response.status_code == 404


def test_remove_member_revokes_access_and_last_owner_is_protected(client, db_session):
    org = seed(db_session)
    colleague = User(id=USER_2, email="colleague@example.com")
    db_session.add(colleague)
    db_session.commit()
    members_url = f"/api/v2/workspaces/{org.id}/members"
    client.post(members_url, json={"email": "colleague@example.com", "role": "member"})

    assert client.delete(f"{members_url}/{USER_2}").status_code == 204
    assert len(client.get(members_url).json()) == 1

    assert client.delete(f"{members_url}/{USER_ID}").status_code == 409

    assert client.delete(f"{members_url}/nonexistent-user-id").status_code == 204


def test_non_admin_cannot_add_or_remove_members(client, db_session):
    org = seed(db_session, role="member")
    colleague = User(id=USER_2, email="colleague@example.com")
    db_session.add(colleague)
    db_session.commit()

    assert (
        client.post(
            f"/api/v2/workspaces/{org.id}/members",
            json={"email": "colleague@example.com"},
        ).status_code
        == 403
    )
    as_user(USER_ID, "founder@example.com")
    assert (
        client.delete(f"/api/v2/workspaces/{org.id}/members/{USER_2}").status_code == 403
    )
