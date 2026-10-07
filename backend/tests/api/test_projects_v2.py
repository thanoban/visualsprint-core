from app.auth import dependency as auth_dep
from app.db.models import Customer, Org, OrgMember, Project, ProjectMember, User
from app.main import app

USER_1 = "test-user-0000-0000-0000-000000000000"
USER_2 = "22222222-2222-2222-2222-222222222222"


def seed(db):
    org = Org(name="Acme workspace")
    db.add(org)
    db.flush()
    db.add_all(
        [
            User(id=USER_1, email="founder@example.com"),
            User(id=USER_2, email="colleague@example.com"),
            OrgMember(org_id=org.id, user_id=USER_1, role="owner"),
            OrgMember(org_id=org.id, user_id=USER_2, role="admin"),
        ]
    )
    db.commit()
    return org


def as_user(user_id, email):
    app.dependency_overrides[auth_dep.get_current_user] = lambda: User(id=user_id, email=email)


def test_duplicate_customer_names_are_allowed_and_contacts_are_normalized(client, db_session):
    org = seed(db_session)
    url = f"/api/v2/workspaces/{org.id}/customers"
    first = client.post(url, json={"name": " Acme "})
    second = client.post(url, json={"name": "Acme"})
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] != second.json()["id"]

    contact_url = f"{url}/{first.json()['id']}/contacts"
    contact = client.post(
        contact_url,
        json={"email": "Buyer@Example.COM", "display_name": "Buyer", "verified_rule": True},
    )
    duplicate = client.post(contact_url, json={"email": "buyer@example.com"})
    assert contact.status_code == 201
    assert contact.json()["email"] == "buyer@example.com"
    assert duplicate.status_code == 409


def test_private_project_is_visible_only_to_explicit_members_even_workspace_admin(client, db_session):
    org = seed(db_session)
    customer = client.post(
        f"/api/v2/workspaces/{org.id}/customers", json={"name": "Customer"}
    ).json()
    project = client.post(
        f"/api/v2/workspaces/{org.id}/projects",
        json={"name": "Private renewal", "customer_id": customer["id"]},
    )
    assert project.status_code == 201
    assert project.json()["visibility"] == "private"
    assert project.json()["role"] == "owner"

    as_user(USER_2, "colleague@example.com")
    assert client.get(f"/api/v2/workspaces/{org.id}/projects").json() == []
    customer_rows = client.get(f"/api/v2/workspaces/{org.id}/customers").json()
    assert customer_rows[0]["visible_project_count"] == 0

    as_user(USER_1, "founder@example.com")
    added = client.put(
        f"/api/v2/workspaces/{org.id}/projects/{project.json()['id']}/members",
        json={"user_id": USER_2, "role": "viewer"},
    )
    assert added.status_code == 200
    as_user(USER_2, "colleague@example.com")
    projects = client.get(f"/api/v2/workspaces/{org.id}/projects").json()
    assert len(projects) == 1
    assert projects[0]["role"] == "viewer"
    assert client.get(f"/api/v2/workspaces/{org.id}/customers").json()[0][
        "visible_project_count"
    ] == 1


def test_project_rejects_customer_from_another_workspace(client, db_session):
    org = seed(db_session)
    other = Org(name="Other")
    db_session.add(other)
    db_session.flush()
    customer = Customer(org_id=other.id, name="Secret customer")
    db_session.add(customer)
    db_session.commit()
    response = client.post(
        f"/api/v2/workspaces/{org.id}/projects",
        json={"name": "Leak", "customer_id": customer.id},
    )
    assert response.status_code == 404
    assert db_session.query(Project).count() == 0


def test_only_project_owner_can_update_and_version_conflicts_are_rejected(client, db_session):
    org = seed(db_session)
    project = client.post(
        f"/api/v2/workspaces/{org.id}/projects", json={"name": "Launch"}
    ).json()
    client.put(
        f"/api/v2/workspaces/{org.id}/projects/{project['id']}/members",
        json={"user_id": USER_2, "role": "editor"},
    )
    as_user(USER_2, "colleague@example.com")
    denied = client.patch(
        f"/api/v2/workspaces/{org.id}/projects/{project['id']}",
        json={"version": 1, "name": "Changed"},
    )
    assert denied.status_code == 403

    as_user(USER_1, "founder@example.com")
    updated = client.patch(
        f"/api/v2/workspaces/{org.id}/projects/{project['id']}",
        json={"version": 1, "name": "Launch v2"},
    )
    stale = client.patch(
        f"/api/v2/workspaces/{org.id}/projects/{project['id']}",
        json={"version": 1, "name": "Stale"},
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2
    assert stale.status_code == 409


def test_target_project_member_must_belong_to_workspace(client, db_session):
    org = seed(db_session)
    outsider = User(id="33333333-3333-3333-3333-333333333333", email="outside@example.com")
    db_session.add(outsider)
    db_session.commit()
    project = client.post(
        f"/api/v2/workspaces/{org.id}/projects", json={"name": "Private"}
    ).json()
    response = client.put(
        f"/api/v2/workspaces/{org.id}/projects/{project['id']}/members",
        json={"user_id": outsider.id, "role": "viewer"},
    )
    assert response.status_code == 404
    assert db_session.query(ProjectMember).count() == 1


def test_removing_member_revokes_private_project_and_last_owner_is_protected(client, db_session):
    org = seed(db_session)
    project = client.post(
        f"/api/v2/workspaces/{org.id}/projects", json={"name": "Private"}
    ).json()
    member_url = f"/api/v2/workspaces/{org.id}/projects/{project['id']}/members"
    assert client.put(member_url, json={"user_id": USER_2, "role": "viewer"}).status_code == 200
    assert client.delete(f"{member_url}/{USER_2}").status_code == 204
    as_user(USER_2, "colleague@example.com")
    assert client.get(f"/api/v2/workspaces/{org.id}/projects").json() == []

    as_user(USER_1, "founder@example.com")
    assert client.delete(f"{member_url}/{USER_1}").status_code == 409
    demote = client.put(member_url, json={"user_id": USER_1, "role": "viewer"})
    assert demote.status_code == 409


def test_archived_customer_cannot_receive_new_projects(client, db_session):
    org = seed(db_session)
    customer = client.post(
        f"/api/v2/workspaces/{org.id}/customers", json={"name": "Former customer"}
    ).json()
    archived = client.post(
        f"/api/v2/workspaces/{org.id}/customers/{customer['id']}/archive"
    )
    assert archived.status_code == 200
    response = client.post(
        f"/api/v2/workspaces/{org.id}/projects",
        json={"name": "Should not start", "customer_id": customer["id"]},
    )
    assert response.status_code == 404
