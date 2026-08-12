from datetime import UTC, datetime

from app.agents.longitudinal_common import LongitudinalEvidenceItem
from app.agents.participant_narrator import ParticipantNarratorInput
from app.agents.pattern import PatternJudgement, RepetitionCandidateInput, analyze_pattern
from app.agents.progress import ProgressInput, ProgressPeriod, assess_progress
from app.db.models import Confidence, KnowledgeType, LifecycleState
from app.interfaces.llm import LlmUsage


class SequenceLlm:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        response = self.responses.pop(0)
        assert isinstance(response, kwargs["schema"])
        return response, LlmUsage(model=kwargs["model"])


def _evidence(item_id: str) -> LongitudinalEvidenceItem:
    return LongitudinalEvidenceItem(
        id=item_id,
        type=KnowledgeType.BLOCKER,
        statement="Gateway access is still blocked",
        lifecycle_state=LifecycleState.RECURRING,
        confidence=Confidence.VERIFIED,
        meeting_at=datetime(2026, 8, 1, tzinfo=UTC),
    )


async def test_pattern_ensemble_abstains_when_zero_temperature_samples_disagree():
    payload = RepetitionCandidateInput(candidate_id="candidate", items=[_evidence("a")])
    llm = SequenceLlm(
        [
            PatternJudgement(
                candidate_id="candidate",
                verdict="stagnation",
                statement="The blocker repeated.",
                evidence_item_ids=["a"],
            ),
            PatternJudgement(
                candidate_id="candidate",
                verdict="progress",
                statement="The blocker advanced.",
                evidence_item_ids=["a"],
            ),
        ]
    )

    result, _usage = await analyze_pattern(llm, payload, model="fake", ensemble_size=2)

    assert result is None
    assert all(call["temperature"] == 0.0 for call in llm.calls)


async def test_progress_floor_returns_insufficient_without_calling_llm():
    llm = SequenceLlm([])
    payload = ProgressInput(
        person_id="person",
        periods=[
            ProgressPeriod(label="earlier", meeting_count=1, commitment_ids=["a"]),
            ProgressPeriod(label="later", meeting_count=1, commitment_ids=["b"]),
        ],
    )

    result, _usage = await assess_progress(llm, payload, model="fake")

    assert result is not None and result.sufficient_data is False
    assert llm.calls == []


def test_narrator_input_cannot_contain_raw_transcript():
    fields = ParticipantNarratorInput.model_fields
    assert "transcript" not in fields
    assert "utterances" not in fields
    assert "raw_transcript" not in fields
