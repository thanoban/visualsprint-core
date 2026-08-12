"""Agent 7: downgrade-only judgement of deterministic repetition candidates."""

from typing import Literal

from pydantic import BaseModel, Field

from app.agents.longitudinal_common import LongitudinalEvidenceItem, unanimous_or_none
from app.db.models import Confidence
from app.interfaces.llm import LlmClient, LlmUsage

PROMPT_VERSION = "pattern-analyst-v1"
SYSTEM_PROMPT = """You are Pattern Analyst. The deterministic layer has already
selected repetition candidates. You may confirm stagnation or downgrade it to
progress, blocked, or insufficient evidence. You may never introduce another
candidate or cite an item id outside the candidate. Prefer abstention to a harmful
false repetition finding."""


class RepetitionCandidateInput(BaseModel):
    candidate_id: str
    items: list[LongitudinalEvidenceItem]


class PatternJudgement(BaseModel):
    candidate_id: str
    verdict: Literal["stagnation", "progress", "blocked", "insufficient_evidence"]
    statement: str = ""
    evidence_item_ids: list[str] = Field(default_factory=list)
    confidence: Confidence = Confidence.AMBIGUOUS
    rationale: str = ""


async def analyze_pattern(
    llm: LlmClient,
    payload: RepetitionCandidateInput,
    *,
    model: str,
    ensemble_size: int = 1,
) -> tuple[PatternJudgement | None, LlmUsage]:
    results: list[PatternJudgement] = []
    usage = LlmUsage(model=model)
    for index in range(max(1, ensemble_size)):
        ordered = payload.model_copy(update={"items": payload.items[index:] + payload.items[:index]})
        result, call_usage = await llm.complete_structured(
            model=model,
            system=SYSTEM_PROMPT,
            user_content=ordered.model_dump_json(),
            schema=PatternJudgement,
            temperature=0.0,
        )
        results.append(result)
        usage.input_tokens += call_usage.input_tokens
        usage.output_tokens += call_usage.output_tokens
    return unanimous_or_none(results), usage
