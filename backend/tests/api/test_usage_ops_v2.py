"""Tests for F13 usage, export and deletion job APIs."""

from datetime import UTC, datetime
from decimal import Decimal

from app.auth import dependency as auth_dep
from app.db.models import (
    AsyncJobStatus,
    DeletionJob,
    ExportJob,
    LlmCall,
    Org,
    OrgMember,
    Project,
    ProjectMember,
    UsageReservation,
    UsageReservationStatus,
    User,
)
from app.main import app

USER_OWNER = "ops2-user-0000-0000-0000-000000000001"
USER_MEMBER = "ops2-user-0000-0000-0000-000000000002"


def _seed(db):
    org = Org(name="OpsV2Org", capture_monthly_minutes=120)
    db.add(org)
    db.flush()
    db.add_all(
        [
            User(id=USER_OWNER, email="owner@example.com"),
            User(id=USER_MEMBER, email="member@example.com"),
            OrgMember(org_id=org.id, user_id=USER_OWNER, role="owner"),
            OrgMember(org_id=org.id, user_id=USER_MEMBER, role="member"),
        ]
    )
    db.flush()
    return org


def _as(user_id: str) -> None:
    app.dependency_overrides[auth_dep.get_current_user] = lambda: User(id=user_id, email="x@y.com")


def _project(db, org_id, owner_id):
    p = Project(org_id=org_id, name="P1", visibility="private", status="active", version=1)
    db.add(p)
    db.flush()
    db.add(ProjectMember(org_id=org_id, project_id=p.id, user_id=owner_id, role="owner"))
    db.flush()
    return p


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------


def test_usage_empty(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_OWNER)

    resp = client.get(f"/api/v2/workspaces/{org.id}/usage")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["org_id"] == org.id
    assert body["capture"]["reserved_minutes"] == 0.0
    assert body["capture"]["reconciled_minutes"] == 0.0
    assert body["capture"]["limit_minutes"] == 120
    assert body["llm"]["total_tokens"] == 0
    assert body["llm"]["over_budget"] is False


def test_usage_with_llm_calls(client, db_session):
    org = _seed(db_session)
    db_session.add(
        LlmCall(
            org_id=org.id,
            stage="understand",
            model="gemini-2.5-pro",
            input_tokens=500,
            output_tokens=200,
            latency_ms=1200,
            ok=True,
            at=datetime.now(UTC),
        )
    )
    db_session.commit()
    _as(USER_OWNER)

    resp = client.get(f"/api/v2/workspaces/{org.id}/usage")
    assert resp.status_code == 200
    body = resp.json()
    assert body["llm"]["input_tokens"] == 500
    assert body["llm"]["output_tokens"] == 200
    assert body["llm"]["total_tokens"] == 700


def test_usage_over_budget(client, db_session):
    org = _seed(db_session)
    org.monthly_llm_token_budget = 100
    db_session.add(
        LlmCall(
            org_id=org.id,
            stage="understand",
            model="gemini-2.5-pro",
            input_tokens=80,
            output_tokens=40,
            latency_ms=100,
            ok=True,
            at=datetime.now(UTC),
        )
    )
    db_session.commit()
    _as(USER_OWNER)

    resp = client.get(f"/api/v2/workspaces/{org.id}/usage")
    assert resp.status_code == 200
    assert resp.json()["llm"]["over_budget"] is True


def test_usage_period_filter(client, db_session):
    org = _seed(db_session)
    # Add an LLM call in a different month (January 2025)
    db_session.add(
        LlmCall(
            org_id=org.id,
            stage="understand",
            model="gemini-2.5-pro",
            input_tokens=9999,
            output_tokens=9999,
            latency_ms=100,
            ok=True,
            at=datetime(2025, 1, 15, tzinfo=UTC),
        )
    )
    db_session.commit()
    _as(USER_OWNER)

    now = datetime.now(UTC)
    resp = client.get(f"/api/v2/workspaces/{org.id}/usage?year={now.year}&month={now.month}")
    assert resp.status_code == 200
    # The Jan 2025 call should not appear in the current month's total
    assert resp.json()["llm"]["total_tokens"] == 0


# ---------------------------------------------------------------------------
# Export jobs
# ---------------------------------------------------------------------------


def test_create_workspace_export_owner(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_OWNER)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/exports",
        json={"scope_kind": "workspace", "scope_id": org.id},
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["scope_kind"] == "workspace"
    assert body["status"] == "pending"
    assert body["download_url"] is None


def test_create_workspace_export_member_403(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_MEMBER)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/exports",
        json={"scope_kind": "workspace", "scope_id": org.id},
    )
    assert resp.status_code == 403


def test_create_project_export_member(client, db_session):
    org = _seed(db_session)
    p = _project(db_session, org.id, USER_OWNER)
    db_session.add(ProjectMember(org_id=org.id, project_id=p.id, user_id=USER_MEMBER, role="viewer"))
    db_session.commit()
    _as(USER_MEMBER)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/exports",
        json={"scope_kind": "project", "scope_id": p.id},
    )
    assert resp.status_code == 202
    assert resp.json()["scope_kind"] == "project"


def test_create_project_export_non_member_404(client, db_session):
    org = _seed(db_session)
    p = _project(db_session, org.id, USER_OWNER)
    db_session.commit()
    _as(USER_MEMBER)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/exports",
        json={"scope_kind": "project", "scope_id": p.id},
    )
    assert resp.status_code == 404


def test_get_export_job(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_OWNER)

    create = client.post(
        f"/api/v2/workspaces/{org.id}/exports",
        json={"scope_kind": "workspace", "scope_id": org.id},
    )
    job_id = create.json()["id"]

    resp = client.get(f"/api/v2/workspaces/{org.id}/exports/{job_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == job_id
    assert resp.json()["status"] == "pending"


def test_get_export_other_user_404(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_OWNER)

    create = client.post(
        f"/api/v2/workspaces/{org.id}/exports",
        json={"scope_kind": "workspace", "scope_id": org.id},
    )
    job_id = create.json()["id"]

    _as(USER_MEMBER)
    resp = client.get(f"/api/v2/workspaces/{org.id}/exports/{job_id}")
    assert resp.status_code == 404


def test_create_export_invalid_scope_422(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_OWNER)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/exports",
        json={"scope_kind": "meeting", "scope_id": "x"},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Deletion jobs
# ---------------------------------------------------------------------------


def test_create_workspace_deletion_owner(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_OWNER)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/deletions",
        json={"scope_kind": "workspace", "scope_id": org.id},
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["scope_kind"] == "workspace"
    assert body["status"] == "pending"


def test_create_workspace_deletion_member_403(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_MEMBER)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/deletions",
        json={"scope_kind": "workspace", "scope_id": org.id},
    )
    assert resp.status_code == 403


def test_create_project_deletion_owner(client, db_session):
    org = _seed(db_session)
    p = _project(db_session, org.id, USER_OWNER)
    db_session.commit()
    _as(USER_OWNER)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/deletions",
        json={"scope_kind": "project", "scope_id": p.id},
    )
    assert resp.status_code == 202


def test_create_project_deletion_member_403(client, db_session):
    org = _seed(db_session)
    p = _project(db_session, org.id, USER_OWNER)
    db_session.add(ProjectMember(org_id=org.id, project_id=p.id, user_id=USER_MEMBER, role="viewer"))
    db_session.commit()
    _as(USER_MEMBER)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/deletions",
        json={"scope_kind": "project", "scope_id": p.id},
    )
    assert resp.status_code == 403


def test_get_deletion_job(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_OWNER)

    create = client.post(
        f"/api/v2/workspaces/{org.id}/deletions",
        json={"scope_kind": "workspace", "scope_id": org.id},
    )
    job_id = create.json()["id"]

    resp = client.get(f"/api/v2/workspaces/{org.id}/deletions/{job_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == job_id


def test_deletion_invalid_scope_422(client, db_session):
    org = _seed(db_session)
    db_session.commit()
    _as(USER_OWNER)

    resp = client.post(
        f"/api/v2/workspaces/{org.id}/deletions",
        json={"scope_kind": "meeting", "scope_id": "x"},
    )
    assert resp.status_code == 422
