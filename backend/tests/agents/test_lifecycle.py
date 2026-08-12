from app.agents.lifecycle import derive_lifecycle_states_for_items
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
)


def _session(db):
    org = Org(name="acme")
    db.add(org)
    db.flush()
    meeting = Meeting(org_id=org.id, title="Standup", platform="upload")
    db.add(meeting)
    db.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()
    return org, session


def test_verified_resolves_edge_closes_the_target_item(db):
    org, session = _session(db)
    target = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.COMMITMENT,
        statement="Fix the gateway",
        confidence=Confidence.VERIFIED,
    )
    source = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.FACT,
        statement="Gateway fix shipped",
        confidence=Confidence.VERIFIED,
    )
    db.add_all([target, source])
    db.flush()
    db.add(
        KnowledgeEdge(
            org_id=org.id,
            from_item_id=source.id,
            to_item_id=target.id,
            kind=EdgeKind.RESOLVES,
        )
    )
    db.flush()

    derive_lifecycle_states_for_items(db, {target.id})

    assert target.lifecycle_state == LifecycleState.RESOLVED


def test_unsupported_edge_cannot_close_a_verified_item(db):
    org, session = _session(db)
    target = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.COMMITMENT,
        statement="Fix the gateway",
        confidence=Confidence.VERIFIED,
    )
    source = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.FACT,
        statement="Gateway fix shipped",
        confidence=Confidence.UNSUPPORTED,
    )
    db.add_all([target, source])
    db.flush()
    db.add(
        KnowledgeEdge(
            org_id=org.id,
            from_item_id=source.id,
            to_item_id=target.id,
            kind=EdgeKind.RESOLVES,
        )
    )
    db.flush()

    derive_lifecycle_states_for_items(db, {target.id})

    assert target.lifecycle_state == LifecycleState.NEW
