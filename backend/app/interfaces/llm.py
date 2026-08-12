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
        temperature: float = 0.0,
        images: list[bytes] = [],  # noqa: B006 — Protocol default, never mutated
    ) -> tuple[T, LlmUsage]:
        """Run one structured completion; raises on schema-invalid output after retries.

        `temperature` defaults to zero because extraction, classification,
        verification, and judgement must be reproducible. A non-zero value is
        reserved for deliberately generative prose and must be justified at
        the call site.

        `images` is optional and additive — every existing text-only call
        site is unaffected by its presence. Raw JPEG/PNG bytes (as produced
        by app.screen.keyframe_detect's JPEG-encoded KeyframeCandidate);
        implementations attach them as vision content blocks ahead of
        `user_content`. A caller passing images to a model that doesn't
        support vision should get a clear provider-level error, not a
        silent text-only fallback that pretends the images were considered.
        """
        ...
