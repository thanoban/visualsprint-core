import pytest

from app.adapters.vlm_caption import NotImplementedVlmCaptioner, caption_keyframe


class FakeCaptioner:
    async def caption(self, image_bytes: bytes) -> str:
        return f"a screen showing {len(image_bytes)} bytes"


async def test_caption_keyframe_delegates_to_provided_captioner():
    image_bytes = b"fake-jpeg-bytes"
    result = await caption_keyframe(image_bytes, captioner=FakeCaptioner())
    assert result == f"a screen showing {len(image_bytes)} bytes"


async def test_caption_keyframe_default_captioner_raises_not_implemented():
    with pytest.raises(NotImplementedError, match="LlmClient"):
        await caption_keyframe(b"fake-jpeg-bytes")


async def test_not_implemented_captioner_raises_directly():
    with pytest.raises(NotImplementedError):
        await NotImplementedVlmCaptioner().caption(b"x")
