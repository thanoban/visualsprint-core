"""Agent 9: transcript-free narrative from audited findings only."""

from pydantic import BaseModel, Field

from app.agents.longitudinal_common import AuditableClaim
from app.interfaces.llm import LlmClient

PROMPT_VERSION = "participant-narrator-v1"
SYSTEM_PROMPT = """Write a concise, neutral team-improvement summary using only
the audited structured findings. Never rank, grade, or score the participant. State
coverage limitations and insufficient evidence plainly."""


class ParticipantNarratorInput(BaseModel):
    person_id: str
    display_name: str
    audited_findings: list[AuditableClaim] = Field(default_factory=list)
    coverage_disclosure: dict[str, object]


class ParticipantNarrative(BaseModel):
    summary: str


async def narrate_participant(
    llm: LlmClient, payload: ParticipantNarratorInput, *, model: str
) -> ParticipantNarrative:
    result, _usage = await llm.complete_structured(
        model=model,
        system=SYSTEM_PROMPT,
        user_content=payload.model_dump_json(),
        schema=ParticipantNarrative,
        # Deliberate exception: facts are already audited and schema-bound;
        # a small amount of sampling improves prose without changing claims.
        temperature=0.25,
    )
    return result
