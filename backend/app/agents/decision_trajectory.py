"""Agent 6: decision trajectories, grounded in edge rationales."""

from typing import Literal

from pydantic import BaseModel, Field

from app.agents.longitudinal_common import LongitudinalEvidenceItem, unanimous_or_none
from app.db.models import Confidence
from app.interfaces.llm import LlmClient, LlmUsage

PROMPT_VERSION = "decision-trajectory-v1"
SYSTEM_PROMPT = """You are Decision Trajectory Analyst. Judge only the supplied
decision chain. A revision is principled only when an edge rationale describes new
information; revision count alone is never churn. Abstain when the rationale is thin.
Cite only supplied item ids. Do not invent evidence."""


class DecisionTrajectoryInput(BaseModel):
    person_id: str
    decisions: list[LongitudinalEvidenceItem]


class DecisionTrajectoryFinding(BaseModel):
    status: Literal["held", "revised", "churn", "insufficient_evidence"]
    statement: str = ""
    evidence_item_ids: list[str] = Field(default_factory=list)
    confidence: Confidence = Confidence.AMBIGUOUS
    rationale: str = ""


async def analyze_decision_trajectory(
    llm: LlmClient,
    payload: DecisionTrajectoryInput,
    *,
    model: str,
    ensemble_size: int = 1,
) -> tuple[DecisionTrajectoryFinding | None, LlmUsage]:
    results: list[DecisionTrajectoryFinding] = []
    usage = LlmUsage(model=model)
    for index in range(max(1, ensemble_size)):
        ordered = payload.model_copy(
            update={"decisions": payload.decisions[index:] + payload.decisions[:index]}
        )
        result, call_usage = await llm.complete_structured(
            model=model,
            system=SYSTEM_PROMPT,
            user_content=ordered.model_dump_json(),
            schema=DecisionTrajectoryFinding,
            temperature=0.0,
        )
        results.append(result)
        usage.input_tokens += call_usage.input_tokens
        usage.output_tokens += call_usage.output_tokens
    return unanimous_or_none(results), usage
