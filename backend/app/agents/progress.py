"""Agent 8: period-over-period progress with a structural sample floor."""

from pydantic import BaseModel, Field

from app.agents.longitudinal_common import unanimous_or_none
from app.db.models import Confidence
from app.interfaces.llm import LlmClient, LlmUsage

PROMPT_VERSION = "progress-assessor-v1"
MIN_COMPARABLE_COMMITMENTS = 5
MIN_MEETINGS = 3
SYSTEM_PROMPT = """You are Progress Assessor. Report movement, denominators, and
coverage caveats; never grades or performance scores. Use only the supplied period
counts and evidence ids. Insufficient data is the correct answer when evidence is
thin."""


class ProgressPeriod(BaseModel):
    label: str
    meeting_count: int
    commitment_ids: list[str] = Field(default_factory=list)
    delivered_ids: list[str] = Field(default_factory=list)
    blocked_ids: list[str] = Field(default_factory=list)
    coverage_gap_count: int = 0


class ProgressInput(BaseModel):
    person_id: str
    periods: list[ProgressPeriod]


class ProgressAssessment(BaseModel):
    sufficient_data: bool
    statement: str
    evidence_item_ids: list[str] = Field(default_factory=list)
    confidence: Confidence = Confidence.AMBIGUOUS
    rationale: str = ""


def has_minimum_sample(payload: ProgressInput) -> bool:
    return (
        sum(len(period.commitment_ids) for period in payload.periods)
        >= MIN_COMPARABLE_COMMITMENTS
        and sum(period.meeting_count for period in payload.periods) >= MIN_MEETINGS
        and len(payload.periods) >= 2
    )


async def assess_progress(
    llm: LlmClient,
    payload: ProgressInput,
    *,
    model: str,
    ensemble_size: int = 1,
) -> tuple[ProgressAssessment | None, LlmUsage]:
    if not has_minimum_sample(payload):
        return ProgressAssessment(
            sufficient_data=False,
            statement="Insufficient comparable data to assess progress.",
            rationale="Minimum sample is five commitments across at least three meetings.",
        ), LlmUsage(model=model)
    results: list[ProgressAssessment] = []
    usage = LlmUsage(model=model)
    for index in range(max(1, ensemble_size)):
        ordered = payload.model_copy(update={"periods": payload.periods[index:] + payload.periods[:index]})
        result, call_usage = await llm.complete_structured(
            model=model,
            system=SYSTEM_PROMPT,
            user_content=ordered.model_dump_json(),
            schema=ProgressAssessment,
            temperature=0.0,
        )
        results.append(result)
        usage.input_tokens += call_usage.input_tokens
        usage.output_tokens += call_usage.output_tokens
    return unanimous_or_none(results), usage
