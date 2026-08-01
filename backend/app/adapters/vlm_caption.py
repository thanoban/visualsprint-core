"""Keyframe captioning — cheap image-to-text for VLM captions on keyframes.

`LlmClient` (app/interfaces/llm.py) is text-only: `complete_structured` takes
`user_content: str` and returns a Pydantic-validated result, with no
image/vision parameter anywhere in the Protocol. Reaching past that boundary
to call a vision-capable vendor SDK directly from here would break the
"every external dependency goes through its swap-point interface" rule
(CLAUDE.md #4) — `llm_vertex.py` is the designated `LlmClient` swap point and
this module must not edit it or bypass it.

So this file defines its own minimal `VlmCaptioner` Protocol as the intended
swap point for keyframe captioning, with a placeholder implementation that
raises until one of two things happens: `LlmClient.complete_structured` gains
an image parameter, or a separate vision-capable call path is chosen. Either
way, callers can be written against `caption_keyframe`/`VlmCaptioner` today
without churn later.
"""

from __future__ import annotations

from typing import Protocol


class VlmCaptioner(Protocol):
    async def caption(self, image_bytes: bytes) -> str:
        """Returns a short natural-language caption of the screen content."""
        ...


class NotImplementedVlmCaptioner:
    """Placeholder `VlmCaptioner` — structurally complete, raises until wired.

    Exists so `caption_keyframe` and its callers are importable and testable
    (with a fake `VlmCaptioner`) before a real vision path exists. Do not
    silently return an empty caption here — a caller that isn't checking for
    this would produce a `Keyframe.vlm_caption` that reads as "verified
    empty" rather than "not attempted".
    """

    async def caption(self, image_bytes: bytes) -> str:
        raise NotImplementedError(
            "VlmCaptioner has no working implementation yet — LlmClient "
            "(app/interfaces/llm.py) is text-only (user_content: str, no "
            "image parameter). Wire this once vision input is added to "
            "LlmClient, or once another vision-capable call path is chosen."
        )


async def caption_keyframe(image_bytes: bytes, captioner: VlmCaptioner | None = None) -> str:
    captioner = captioner or NotImplementedVlmCaptioner()
    return await captioner.caption(image_bytes)
