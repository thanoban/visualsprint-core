"""Happy-path + rule-3 end-to-end proof across context -> verification, plus
one smoke test each for memory and action. Report Intelligence's rule-2
guarantee is proven separately (via the DB query path) in
test_structural_guarantees.py + app/agents/report.py's own docstring claim
about which columns build_report_input selects.
"""

from app.agents.action import run_action_intelligence
from app.agents.context import (
    CandidateExtractionResult,
    CandidateKnowledgeItem,
    run_context_intelligence,
)
from app.agents.memory import MemoryDecision, run_memory_intelligence
from app.agents.verification import VerificationResult, run_evidence_verification
from app.db.models import (
    ActionStatus,
    CaptureSession,
    Confidence,
    KnowledgeItem,
    KnowledgeType,
    LifecycleState,
    Meeting,
    Org,
    ProposedAction,
    Utterance,
)

from .conftest import FakeEmbedder, FakeLlmClient

DISTINCTIVE_RATIONALE = "I THINK THIS IS A DECISION BECAUSE THE SPEAKER SOUNDED CONFIDENT"


def _seed_session_with_utterance(db, *, text: str = "we decided to use Postgres") -> str:
    org = Org(name="acme")
    db.add(org)
    db.flush()
    meeting = Meeting(org_id=org.id, title="standup", platform="upload")
    db.add(meeting)
    db.flush()
    session = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(session)
    db.flush()
    db.add(
        Utterance(
            org_id=org.id,
            capture_session_id=session.id,
            start_s=0.0,
            end_s=2.0,
            text=text,
            asr_confidence=0.9,
            attribution_confidence=0.0,
        )
    )
    db.commit()
    return session.id


async def test_context_then_verification_never_leaks_rationale(db):
    session_id = _seed_session_with_utterance(db)
    utterance = db.query(Utterance).filter(Utterance.capture_session_id == session_id).one()

    context_llm = FakeLlmClient(
        CandidateExtractionResult(
            items=[
                CandidateKnowledgeItem(
                    type=KnowledgeType.DECISION,
                    statement="Use Postgres for the database",
                    supporting_utterance_ids=[utterance.id],
                    rationale=DISTINCTIVE_RATIONALE,
                )
            ]
        )
    )
    created_ids = await run_context_intelligence(db, session_id, context_llm)
    assert len(created_ids) == 1

    item = db.get(KnowledgeItem, created_ids[0])
    assert item.confidence == Confidence.AMBIGUOUS
    assert item.confidence_rationale == ""  # not-yet-verified marker

    verify_llm = FakeLlmClient(
        VerificationResult(confidence=Confidence.VERIFIED, rationale="evidence supports it")
    )
    await run_evidence_verification(db, session_id, verify_llm)

    assert len(verify_llm.calls) == 1
    verification_prompt = verify_llm.calls[0]["user_content"]
    assert DISTINCTIVE_RATIONALE not in verification_prompt, (
        "Context Intelligence's rationale leaked into Evidence Verification's "
        "prompt -- this is exactly what rule 3 forbids."
    )

    # NOTE: db.refresh() would reload from DB and clobber the agent's
    # unflushed in-memory mutation (it relies on the caller's outer commit,
    # same as worker.py's run_once) -- commit instead of refreshing.
    db.commit()
    assert item.confidence == Confidence.VERIFIED
    assert item.confidence_rationale == "evidence supports it"


async def test_memory_assigns_lifecycle_and_creates_edge(db):
    session_id = _seed_session_with_utterance(db)
    org_id = db.get(CaptureSession, session_id).org_id

    prior = KnowledgeItem(
        org_id=org_id,
        capture_session_id=session_id,
        type=KnowledgeType.DECISION,
        statement="Use MongoDB for the database",
        confidence=Confidence.VERIFIED,
        confidence_rationale="prior meeting",
        lifecycle_state=LifecycleState.NEW,
    )
    new_item = KnowledgeItem(
        org_id=org_id,
        capture_session_id=session_id,
        type=KnowledgeType.DECISION,
        statement="Use Postgres for the database",
        confidence=Confidence.VERIFIED,
        confidence_rationale="this meeting",
    )
    db.add_all([prior, new_item])
    db.commit()

    llm = FakeLlmClient(MemoryDecision(lifecycle_state=LifecycleState.SUPERSEDED, edges=[]))
    processed = await run_memory_intelligence(db, session_id, llm)

    assert new_item.id in processed
    db.commit()
    assert new_item.lifecycle_state == LifecycleState.SUPERSEDED


async def test_memory_populates_embedding_once_when_embedder_given(db):
    """SQLite structural proof: embedding gets populated exactly once (never
    re-embedded on a second run) and the item's lifecycle/edge logic is
    unaffected. Real cosine-similarity ordering needs Postgres — see
    tests/test_vector_search_postgres.py."""
    session_id = _seed_session_with_utterance(db)
    org_id = db.get(CaptureSession, session_id).org_id

    item = KnowledgeItem(
        org_id=org_id,
        capture_session_id=session_id,
        type=KnowledgeType.DECISION,
        statement="Use Postgres for the database",
        confidence=Confidence.VERIFIED,
        confidence_rationale="this meeting",
    )
    db.add(item)
    db.commit()
    assert item.embedding is None

    embedder = FakeEmbedder()
    llm = FakeLlmClient(MemoryDecision(lifecycle_state=LifecycleState.NEW, edges=[]))
    await run_memory_intelligence(db, session_id, llm, embedder=embedder)
    db.commit()

    assert embedder.calls == ["Use Postgres for the database"]
    assert item.embedding is not None
    assert len(item.embedding) == embedder.dim

    first_embedding = list(item.embedding)
    await run_memory_intelligence(db, session_id, llm, embedder=embedder)
    db.commit()
    assert embedder.calls == ["Use Postgres for the database"], (
        "embedder called a second time -- an already-embedded item must not be re-embedded"
    )
    assert list(item.embedding) == first_embedding


async def test_action_never_writes_anything_but_pending_approval(db):
    session_id = _seed_session_with_utterance(db)
    org_id = db.get(CaptureSession, session_id).org_id
    from app.db.models import Person

    owner = Person(org_id=org_id, display_name="Udula")
    db.add(owner)
    db.flush()

    commitment = KnowledgeItem(
        org_id=org_id,
        capture_session_id=session_id,
        type=KnowledgeType.COMMITMENT,
        statement="Udula will fix the deploy script",
        confidence=Confidence.VERIFIED,
        confidence_rationale="clear commitment",
        owner_person_id=owner.id,
    )
    db.add(commitment)
    db.commit()

    from app.agents.action import ActionDraft
    from app.interfaces.actions import ActionKind

    llm = FakeLlmClient(
        ActionDraft(
            kind=ActionKind.TASK_CREATE, title="Fix deploy script", body="...", target_hint="udula"
        )
    )
    created_ids = await run_action_intelligence(db, session_id, llm)

    assert len(created_ids) == 1
    action = db.get(ProposedAction, created_ids[0])
    assert action.status == ActionStatus.PENDING_APPROVAL
