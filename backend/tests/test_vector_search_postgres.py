"""Real-Postgres proof that pgvector cosine-similarity ordering actually
works — not just that the query doesn't crash. SQLite (tests/api/test_chat.py,
tests/agents/test_pipeline_flow.py) can only prove the plumbing and the
dialect guard, since it can't represent the pgvector `Vector` column at all.

Runs against the same docker-compose dev Postgres as
tests/test_upload_pipeline.py, using a dedicated org name so cleanup can't
race with that file's "default"-org fixtures.
"""

import pytest
from sqlalchemy import select

from app.agents.memory import _find_related
from app.api.chat import _vector_candidates
from app.db.base import get_sessionmaker
from app.db.models import CaptureSession, Confidence, KnowledgeItem, KnowledgeType, Meeting, Org

ORG_NAME = "vector-search-test-org"


def _unit(vec: list[float]) -> list[float]:
    norm = sum(v * v for v in vec) ** 0.5
    return [v / norm for v in vec]


def _sparse_vector(hot_index: int, dim: int = 1024) -> list[float]:
    """A near-orthogonal basis vector per topic -- cosine distance between two
    different hot_index vectors is always ~1.0 (maximally dissimilar), and
    0.0 to itself, so similarity ordering is unambiguous regardless of what a
    real embedding model would actually produce."""
    vec = [0.0] * dim
    vec[hot_index] = 1.0
    return vec


@pytest.fixture
def db():
    Session = get_sessionmaker()
    with Session() as session:
        yield session
        org = session.query(Org).filter(Org.name == ORG_NAME).one_or_none()
        if org is not None:
            session.query(KnowledgeItem).filter(KnowledgeItem.org_id == org.id).delete()
            session.query(CaptureSession).filter(CaptureSession.org_id == org.id).delete()
            session.query(Meeting).filter(Meeting.org_id == org.id).delete()
            session.delete(org)
        session.commit()


def _seed(db) -> tuple[str, KnowledgeItem, KnowledgeItem, KnowledgeItem]:
    """One query item plus: a near-duplicate (same topic vector), and an
    unrelated item (orthogonal vector) -- the near-duplicate must rank first."""
    org = Org(name=ORG_NAME)
    db.add(org)
    db.flush()
    meeting = Meeting(org_id=org.id, title="vector search test", platform="upload")
    db.add(meeting)
    db.flush()
    # Three distinct sessions: _find_related excludes items in the query
    # item's own capture_session_id by design (memory.py), so `near` and
    # `far` must each live in a session different from the query item's.
    session_a = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    session_b = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    session_c = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add_all([session_a, session_b, session_c])
    db.flush()

    near = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session_a.id,
        type=KnowledgeType.DECISION,
        statement="Migrate the primary datastore from MongoDB to Postgres.",
        confidence=Confidence.VERIFIED,
        confidence_rationale="seeded",
        embedding=_sparse_vector(1),
    )
    far = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session_b.id,
        type=KnowledgeType.DECISION,
        statement="Order more coffee for the office kitchen.",
        confidence=Confidence.VERIFIED,
        confidence_rationale="seeded",
        embedding=_sparse_vector(500),
    )
    db.add_all([near, far])
    db.commit()

    query = KnowledgeItem(
        org_id=org.id,
        capture_session_id=session_c.id,
        type=KnowledgeType.DECISION,
        statement="Why did we move off MongoDB?",
        confidence=Confidence.VERIFIED,
        confidence_rationale="seeded query item",
    )
    db.add(query)
    db.commit()

    return org.id, query, near, far


def test_chat_vector_candidates_orders_by_real_cosine_similarity(db):
    org_id, query, near, far = _seed(db)

    results = _vector_candidates(db, org_id, _sparse_vector(1), None)

    assert results, "expected at least the near-duplicate item back"
    result_ids = [r.id for r in results]
    assert near.id in result_ids
    assert result_ids.index(near.id) < (
        result_ids.index(far.id) if far.id in result_ids else len(result_ids)
    )
    # The query item itself was never given an embedding, so it can't match.
    assert query.id not in result_ids


def test_memory_find_related_orders_by_real_cosine_similarity(db):
    org_id, query, near, far = _seed(db)

    related = _find_related(db, query, embedding=_sparse_vector(1))

    related_ids = [r.id for r in related]
    assert near.id in related_ids
    if far.id in related_ids:
        assert related_ids.index(near.id) < related_ids.index(far.id)


def test_embedding_persists_as_the_expected_dimensionality(db):
    """Confirms the pgvector column round-trips a real 1024-dim vector --
    the dimensionality VertexEmbedder is configured to produce
    (app/adapters/embedder_vertex.py's EMBEDDING_DIMENSIONALITY) must match
    KnowledgeItem.embedding's Vector(1024) or every insert fails outright."""
    org_id, query, near, _far = _seed(db)

    reloaded = db.execute(
        select(KnowledgeItem).where(KnowledgeItem.id == near.id)
    ).scalar_one()
    assert len(reloaded.embedding) == 1024
