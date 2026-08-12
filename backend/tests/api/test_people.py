from datetime import UTC, datetime, timedelta

from app.db.models import (
    CaptureSession,
    Confidence,
    EdgeKind,
    KnowledgeEdge,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Meeting,
    Org,
    Person,
    Utterance,
)


def _seed(db):
    org = Org(name="acme")
    db.add(org)
    db.flush()
    owner = Person(org_id=org.id, display_name="Nimal Perera", email="nimal@acme.test")
    blocker_owner = Person(org_id=org.id, display_name="Kavindi Silva")
    db.add_all([owner, blocker_owner])
    db.flush()
    meeting = Meeting(
        org_id=org.id,
        title="Standup",
        platform="upload",
        scheduled_start=datetime(2026, 8, 11, 9, 0, tzinfo=UTC),
    )
    db.add(meeting)
    db.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()
    utterance = Utterance(
        org_id=org.id,
        capture_session_id=session.id,
        person_id=blocker_owner.id,
        start_s=1.0,
        end_s=3.0,
        text="Nimal should fix this once the API key arrives",
        attribution_confidence=1.0,
    )
    db.add(utterance)
    db.flush()
    commitment = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.COMMITMENT,
        statement="Fix the payment gateway",
        owner_person_id=owner.id,
        owner_utterance_id=utterance.id,
        confidence=Confidence.VERIFIED,
        due_at=datetime.now(UTC) - timedelta(days=1),
    )
    blocker = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.BLOCKER,
        statement="API key has not arrived",
        owner_person_id=blocker_owner.id,
        confidence=Confidence.VERIFIED,
        lifecycle_state=LifecycleState.NEW,
    )
    db.add_all([commitment, blocker])
    db.flush()
    db.add(
        KnowledgeEdge(
            org_id=org.id,
            from_item_id=blocker.id,
            to_item_id=commitment.id,
            kind=EdgeKind.BLOCKS,
            rationale="The key blocks the gateway fix.",
        )
    )
    db.commit()
    return org, owner, blocker_owner, commitment


def test_person_detail_shows_blocker_next_to_overdue_commitment(client, db_session):
    org, owner, _blocker_owner, _commitment = _seed(db_session)

    resp = client.get(f"/api/v1/orgs/{org.id}/people/{owner.id}")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["display_name"] == "Nimal Perera"
    assert len(body["commitments"]) == 1
    assert body["commitments"][0]["blockers"][0]["statement"] == "API key has not arrived"
    assert body["commitments"][0]["evidence_url"].endswith(f"item={_commitment.id}")


def test_interaction_map_returns_relationship_edges(client, db_session):
    org, owner, blocker_owner, _commitment = _seed(db_session)

    resp = client.get(f"/api/v1/orgs/{org.id}/people/interactions/map")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {node["display_name"] for node in body["nodes"]} == {
        "Nimal Perera",
        "Kavindi Silva",
    }
    assert {
        (edge["from_person_id"], edge["to_person_id"], edge["kind"]) for edge in body["edges"]
    } == {
        (blocker_owner.id, owner.id, "delegates_to"),
        (blocker_owner.id, owner.id, "blocks"),
    }
    assert all(edge["evidence_url"].startswith("/meetings/") for edge in body["edges"])


def test_analysis_surface_returns_deterministic_graphs_before_agent_run(client, db_session):
    org, owner, _blocker_owner, _commitment = _seed(db_session)

    resp = client.get(f"/api/v1/orgs/{org.id}/people/{owner.id}/analysis/latest")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is False
    assert len(body["commitment_timeline"]) == 1
    assert body["commitment_funnel"] == {
        "stated": 1,
        "open": 1,
        "recurring": 0,
        "blocked": 1,
        "delivered": 0,
    }
