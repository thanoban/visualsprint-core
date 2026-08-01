"""LlmClient swap point — provider-agnostic structured LLM calls.

All five agents and the LLM transcript-repair pass go through this interface.
Structured output only: every call supplies a Pydantic schema and gets a
validated instance back. This is what makes the anti-hallucination rules
type-enforced rather than prompt-enforced.
"""

from typing import Protocol, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class LlmUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""


class LlmClient(Protocol):
    async def complete_structured(
        self,
        *,
        model: str,
        system: str,
        user_content: str,
        schema: type[T],
        max_tokens: int = 4096,
    ) -> tuple[T, LlmUsage]:
        """Run one structured completion; raises on schema-invalid output after retries."""
        ...
