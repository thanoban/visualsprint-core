"""Tests for POST /api/v1/chat.

Exercises the FTS retrieval path (SQLite ILIKE-fallback branch of
`_fts_candidates`, the same function production uses with a postgres
`to_tsvector`/`plainto_tsquery` branch) plus one-hop knowledge_edge expansion
and template-based answer synthesis. The pgvector similarity path
(`_vector_candidates`) is exercised structurally only, since it requires a
real Postgres + pgvector column that SQLite cannot represent — see the
dedicated test below marked accordingly.
"""

import pytest

from app.api.chat import _vector_candidates, get_optional_embedder
from app.db.models import (
    CaptureSession,
    Confidence,
    EdgeKind,
    KnowledgeEdge,
    KnowledgeEvidence,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Meeting,
    Org,
    Person,
    Utterance,
)
from app.main import app


def _seed(db):
    org = Org(name="acme")
    db.add(org)
    db.flush()

    person = Person(org_id=org.id, display_name="Nimal Perera")
    db.add(person)
    db.flush()

    meeting = Meeting(org_id=org.id, title="Infra Sync", platform="upload")
    db.add(meeting)
    db.flush()

    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()

    utt = Utterance(
        org_id=org.id,
        capture_session_id=session.id,
        person_id=person.id,
        start_s=245.0,
        end_s=248.0,
        text="We're moving off MongoDB to Postgres with pgvector.",
    )
    db.add(utt)
    db.flush()

    decision = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.DECISION,
        statement="Migrate the primary datastore from MongoDB to Postgres with pgvector.",
        owner_person_id=person.id,
        lifecycle_state=LifecycleState.NEW,
        confidence=Confidence.VERIFIED,
        confidence_rationale="Directly stated.",
    )
    db.add(decision)
    db.flush()
    db.add(KnowledgeEvidence(org_id=org.id, knowledge_item_id=decision.id, utterance_id=utt.id))

    superseded = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session.id,
        type=KnowledgeType.DECISION,
        statement="Earlier plan: keep MongoDB and add a search index.",
        lifecycle_state=LifecycleState.SUPERSEDED,
        confidence=Confidence.VERIFIED,
        confidence_rationale="Superseded by the pgvector decision.",
    )
    db.add(superseded)
    db.flush()

    db.add(
        KnowledgeEdge(
            org_id=org.id,
            from_item_id=decision.id,
            to_item_id=superseded.id,
            kind=EdgeKind.SUPERSEDES,
            rationale="Postgres+pgvector decision replaces the earlier MongoDB plan.",
        )
    )

    db.commit()
    return org.id


def test_chat_returns_grounded_answer_with_evidence(client, db_session):
    org_id = _seed(db_session)

    resp = client.post(
        "/api/v1/chat",
        json={"org_id": org_id, "question": "why are we using MongoDB?"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    message = body["message"]
    assert message["role"] == "assistant"
    assert "MongoDB" in message["content"]
    assert "Postgres" in message["content"]
    # One-hop edge expansion should surface the superseded item too.
    assert "Earlier plan" in message["content"]

    assert message["evidence"]
    chip = message["evidence"][0]
    assert chip["speaker"] == "Nimal Perera"
    assert chip["meeting_title"] == "Infra Sync"
    assert chip["timestamp_s"] == 245.0


def test_chat_no_match_returns_honest_empty_answer(client, db_session):
    org_id = _seed(db_session)

    resp = client.post(
        "/api/v1/chat",
        json={"org_id": org_id, "question": "zzz nonexistent topic zzz"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "No verified knowledge items matched" in body["message"]["content"]
    assert body["message"]["evidence"] is None


@pytest.mark.skip(
    reason="pgvector cosine-distance ordering requires a real Postgres + pgvector "
    "column; SQLite cannot represent KnowledgeItem.embedding. Structural check only."
)
def test_vector_candidates_requires_postgres(db_session):
    # On SQLite, _vector_candidates must short-circuit to [] rather than attempt
    # a pgvector-specific query the dialect can't run. Kept skipped (not deleted)
    # so a real Postgres CI run can un-skip and verify actual similarity ordering.
    result = _vector_candidates(db_session, "org-1", [0.1] * 1024, None)
    assert result == []


def test_vector_candidates_returns_empty_without_embedding(client, db_session):
    org_id = _seed(db_session)
    assert _vector_candidates(db_session, org_id, None, None) == []
    # Also confirms the SQLite dialect guard short-circuits even if a caller
    # ever passes a real vector before Postgres is available.
    assert _vector_candidates(db_session, org_id, [0.1] * 1024, None) == []


class FakeEmbedder:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def embed(self, text: str) -> list[float]:
        self.calls.append(text)
        return [0.1] * 1024


def test_chat_calls_embedder_when_injected(client, db_session):
    """SQLite structural proof the plumbing works end-to-end: injecting an
    Embedder via the same override mechanism production uses (`get_optional_
    embedder`) means it gets called with the question, and the endpoint
    still responds normally (`_vector_candidates`' dialect guard makes the
    resulting query_embedding a no-op on SQLite -- real ordering is proven
    against Postgres in tests/test_vector_search_postgres.py)."""
    org_id = _seed(db_session)
    fake = FakeEmbedder()
    app.dependency_overrides[get_optional_embedder] = lambda: fake
    try:
        resp = client.post(
            "/api/v1/chat",
            json={"org_id": org_id, "question": "why are we using MongoDB?"},
        )
    finally:
        del app.dependency_overrides[get_optional_embedder]

    assert resp.status_code == 200, resp.text
    assert fake.calls == ["why are we using MongoDB?"]
    # FTS still finds the match; the endpoint doesn't require vector hits.
    assert "MongoDB" in resp.json()["message"]["content"]
