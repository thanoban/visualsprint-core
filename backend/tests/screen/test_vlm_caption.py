import pytest

from app.adapters.vlm_caption import (
    LlmVisionCaptioner,
    NotImplementedVlmCaptioner,
    caption_keyframe,
)
from app.interfaces.llm import LlmUsage


class FakeCaptioner:
    async def caption(self, image_bytes: bytes) -> str:
        return f"a screen showing {len(image_bytes)} bytes"


async def test_caption_keyframe_delegates_to_provided_captioner():
    image_bytes = b"fake-jpeg-bytes"
    result = await caption_keyframe(image_bytes, captioner=FakeCaptioner())
    assert result == f"a screen showing {len(image_bytes)} bytes"


async def test_caption_keyframe_default_captioner_raises_not_implemented():
    with pytest.raises(NotImplementedError, match="LlmVisionCaptioner"):
        await caption_keyframe(b"fake-jpeg-bytes")


async def test_not_implemented_captioner_raises_directly():
    with pytest.raises(NotImplementedError):
        await NotImplementedVlmCaptioner().caption(b"x")


# --- LlmVisionCaptioner --------------------------------------------------


class _FakeVisionLlm:
    """Local fake, not tests/agents/conftest.py's FakeLlmClient -- that one
    predates the `images` parameter and doesn't accept it. Deliberately
    self-contained here rather than editing a fixture shared with concurrent
    work elsewhere in the repo."""

    def __init__(self, caption_text: str = "A terminal showing a stack trace.") -> None:
        self._caption_text = caption_text
        self.calls: list[dict] = []

    async def complete_structured(
        self, *, model, system, user_content, schema, max_tokens=4096, images=[]  # noqa: B006
    ):
        self.calls.append(
            {
                "model": model,
                "system": system,
                "user_content": user_content,
                "schema": schema,
                "images": images,
            }
        )
        return schema(caption=self._caption_text), LlmUsage(input_tokens=5, output_tokens=5, model=model)


async def test_llm_vision_captioner_passes_image_bytes_through():
    llm = _FakeVisionLlm("A slide titled 'Datastore decision'.")
    captioner = LlmVisionCaptioner(llm=llm, model="claude-haiku-4-5-20251001")

    result = await captioner.caption(b"\xff\xd8\xff-fake-jpeg-bytes")

    assert result == "A slide titled 'Datastore decision'."
    assert len(llm.calls) == 1
    assert llm.calls[0]["images"] == [b"\xff\xd8\xff-fake-jpeg-bytes"]
    assert llm.calls[0]["model"] == "claude-haiku-4-5-20251001"


async def test_llm_vision_captioner_works_through_caption_keyframe():
    llm = _FakeVisionLlm("A Jira board with three columns.")
    captioner = LlmVisionCaptioner(llm=llm, model="claude-haiku-4-5-20251001")

    result = await caption_keyframe(b"\xff\xd8\xff-bytes", captioner=captioner)

    assert result == "A Jira board with three columns."
