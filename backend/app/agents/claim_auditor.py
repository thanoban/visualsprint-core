"""Agent 10: blind critic for longitudinal claims."""

from pydantic import BaseModel, Field

from app.agents.longitudinal_common import AuditableClaim, LongitudinalEvidenceItem
from app.db.models import FindingAuditStatus
from app.interfaces.llm import LlmClient

PROMPT_VERSION = "claim-auditor-v1"
SYSTEM_PROMPT = """You are Claim Auditor. Independently check the claim against
the structured evidence. You are intentionally not given the analyst's reasoning.
Cite only supplied item ids. Unsupported claims must not reach users."""


class ClaimAuditInput(BaseModel):
    claim: AuditableClaim
    evidence: list[LongitudinalEvidenceItem]


class ClaimAuditResult(BaseModel):
    status: FindingAuditStatus
    supported_item_ids: list[str] = Field(default_factory=list)
    rationale: str


async def audit_claim(llm: LlmClient, payload: ClaimAuditInput, *, model: str) -> ClaimAuditResult:
    result, _usage = await llm.complete_structured(
        model=model,
        system=SYSTEM_PROMPT,
        user_content=payload.model_dump_json(),
        schema=ClaimAuditResult,
        temperature=0.0,
    )
    return result
