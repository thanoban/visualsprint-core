"""Keyframe captioning — cheap image-to-text for VLM captions on keyframes.

`LlmClient.complete_structured` (app/interfaces/llm.py) now accepts an
optional `images: list[bytes]` parameter, so `LlmVisionCaptioner` below is
the real, wired implementation of `VlmCaptioner`. `NotImplementedVlmCaptioner`
stays as the explicit "nothing configured" default so a caller that forgets
to inject a real captioner gets a loud error instead of a silently-empty
caption that would read as "verified empty" rather than "not attempted".
"""

from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel

from app.interfaces.llm import LlmClient

SYSTEM_PROMPT = """You caption a single screenshot from a work meeting (a
shared screen, slide, terminal, or diagram) for someone who cannot see it.
Describe only what is visible: on-screen text, UI elements, diagrams, code,
error messages. One or two sentences. Do not guess at anything outside the
frame, and do not speculate about what the meeting is about beyond what the
image itself shows."""


class _CaptionResult(BaseModel):
    caption: str


class VlmCaptioner(Protocol):
    async def caption(self, image_bytes: bytes) -> str:
        """Returns a short natural-language caption of the screen content."""
        ...


class NotImplementedVlmCaptioner:
    """Placeholder `VlmCaptioner` — structurally complete, raises until wired.

    Exists so `caption_keyframe` and its callers are importable and testable
    (with a fake `VlmCaptioner`) without requiring a real `LlmClient`
    instance. Do not silently return an empty caption here — a caller that
    isn't checking for this would produce a `Keyframe.vlm_caption` that
    reads as "verified empty" rather than "not attempted".
    """

    async def caption(self, image_bytes: bytes) -> str:
        raise NotImplementedError(
            "VlmCaptioner has no working implementation injected — pass an "
            "LlmVisionCaptioner(llm=...) to caption_keyframe(), or leave "
            "vlm_caption blank at the call site if captioning isn't wanted "
            "for this session."
        )


class LlmVisionCaptioner:
    """`VlmCaptioner` backed by any vision-capable `LlmClient` (Claude on
    Vertex AI supports vision natively). Model tier is caller-supplied
    rather than hardcoded — the screen stage should pass the same cheap
    classification-tier model used elsewhere (settings.model_classify),
    since a caption is a cheap task, not settings.model_extract/report."""

    def __init__(self, llm: LlmClient, model: str) -> None:
        self._llm = llm
        self._model = model

    async def caption(self, image_bytes: bytes) -> str:
        result, _usage = await self._llm.complete_structured(
            model=self._model,
            system=SYSTEM_PROMPT,
            user_content="Caption this screenshot.",
            schema=_CaptionResult,
            images=[image_bytes],
            max_tokens=256,
        )
        return result.caption


async def caption_keyframe(image_bytes: bytes, captioner: VlmCaptioner | None = None) -> str:
    captioner = captioner or NotImplementedVlmCaptioner()
    return await captioner.caption(image_bytes)
