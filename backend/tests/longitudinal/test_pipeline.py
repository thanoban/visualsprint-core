from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.agents.claim_auditor import ClaimAuditResult
from app.agents.participant_narrator import ParticipantNarrative
from app.agents.pattern import PatternJudgement
from app.db.base import Base
from app.db.models import (
    ActionStatus,
    CaptureSession,
    Confidence,
    FindingAuditStatus,
    FindingKind,
    KnowledgeItem,
    KnowledgeType,
    LongitudinalFinding,
    LongitudinalState,
    Meeting,
    Org,
    Person,
    PersonAnalysisRun,
    ProposedAction,
)
from app.interfaces.llm import LlmUsage
from app.longitudinal.pipeline import propose_longitudinal_actions, run_person_analysis


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_all_longitudinal_automations_are_pending_approval_and_idempotent(db):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    person = Person(org_id=org.id, display_name="Nimal")
    meeting = Meeting(org_id=org.id, title="Standup")
    db.add_all([person, meeting])
    db.flush()
    capture = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
    db.add(capture)
    db.flush()
    item = KnowledgeItem(
        org_id=org.id,
        capture_session_id=capture.id,
        owner_person_id=person.id,
        type=KnowledgeType.COMMITMENT,
        statement="Ship the gateway",
        confidence=Confidence.VERIFIED,
    )
    db.add(item)
    db.flush()
    run = PersonAnalysisRun(
        org_id=org.id,
        person_id=person.id,
        period_start=datetime(2026, 8, 1, tzinfo=UTC),
        period_end=datetime(2026, 8, 31, tzinfo=UTC),
        evidence_hash="a" * 64,
        state=LongitudinalState.RECOMMENDING,
    )
    db.add(run)
    db.flush()
    finding = LongitudinalFinding(
        org_id=org.id,
        person_id=person.id,
        analysis_run_id=run.id,
        kind=FindingKind.REPETITION,
        statement="The gateway commitment repeated.",
        confidence=Confidence.VERIFIED,
        evidence_item_ids=[item.id],
        audit_status=FindingAuditStatus.SUPPORTED,
    )
    db.add(finding)
    db.flush()

    created = propose_longitudinal_actions(db, run, [finding])
    repeated = propose_longitudinal_actions(db, run, [finding])
    actions = db.execute(select(ProposedAction)).scalars().all()

    assert len(created) == 4
    assert repeated == []
    assert len(actions) == 4
    assert all(action.status == ActionStatus.PENDING_APPROVAL for action in actions)
    assert {action.payload["automation"] for action in actions} == {
        "pre_meeting_brief",
        "agenda_proposal",
        "stale_commitment_nudge",
        "weekly_digest",
    }


class PipelineLlm:
    def __init__(self, evidence_ids):
        self.evidence_ids = evidence_ids
        self.calls = []

    async def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        schema = kwargs["schema"]
        if schema is PatternJudgement:
            result = PatternJudgement(
                candidate_id=__import__("json").loads(kwargs["user_content"])["candidate_id"],
                verdict="stagnation",
                statement="The same blocker recurred without recorded movement.",
                evidence_item_ids=self.evidence_ids,
                confidence=Confidence.VERIFIED,
                rationale="Both items describe the same unresolved blocker.",
            )
        elif schema is ClaimAuditResult:
            result = ClaimAuditResult(
                status=FindingAuditStatus.SUPPORTED,
                supported_item_ids=self.evidence_ids,
                rationale="The structured evidence supports the claim.",
            )
        elif schema is ParticipantNarrative:
            result = ParticipantNarrative(summary="A recurring blocker needs team support.")
        else:
            raise AssertionError(f"unexpected schema {schema}")
        return result, LlmUsage(model=kwargs["model"])


async def test_full_person_fsm_is_grounded_audited_and_incremental(db):
    org = Org(name="Acme")
    db.add(org)
    db.flush()
    person = Person(org_id=org.id, display_name="Nimal")
    db.add(person)
    db.flush()
    item_ids = []
    for day in (1, 8):
        meeting = Meeting(
            org_id=org.id,
            title="Standup",
            scheduled_start=datetime(2026, 8, day, 9, tzinfo=UTC),
        )
        db.add(meeting)
        db.flush()
        capture = CaptureSession(org_id=org.id, meeting_id=meeting.id, mode="D")
        db.add(capture)
        db.flush()
        item = KnowledgeItem(
            org_id=org.id,
            capture_session_id=capture.id,
            owner_person_id=person.id,
            type=KnowledgeType.BLOCKER,
            statement="Vendor key is still blocking the gateway",
            confidence=Confidence.VERIFIED,
        )
        db.add(item)
        db.flush()
        item_ids.append(item.id)
    llm = PipelineLlm(item_ids)
    start = datetime(2026, 8, 1, tzinfo=UTC)
    end = datetime(2026, 8, 31, tzinfo=UTC)

    run = await run_person_analysis(db, org.id, person.id, start, end, llm)

    assert run.state == LongitudinalState.DONE
    assert run.summary == "A recurring blocker needs team support."
    finding = db.execute(select(LongitudinalFinding)).scalar_one()
    assert finding.evidence_item_ids == item_ids
    assert finding.audit_status == FindingAuditStatus.SUPPORTED
    assert len(db.execute(select(ProposedAction)).scalars().all()) == 4
    call_count = len(llm.calls)

    repeated = await run_person_analysis(db, org.id, person.id, start, end, llm)

    assert repeated.id == run.id
    assert len(llm.calls) == call_count
