"""Tests for GeminiVertexLlmClient's request construction -- mirrors
tests/test_llm_vertex.py's structure for the Claude adapter. Bypasses
__init__ (which resolves a real GCP project via Application Default
Credentials) by constructing the instance directly and injecting a fake
`_client`, so this needs no live GCP credentials to run.
"""

from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from app.adapters.llm_gemini_vertex import GeminiVertexLlmClient, _sniff_media_type
from app.interfaces.llm import LlmUsage

JPEG_MAGIC = b"\xff\xd8\xff\xe0\x00\x10JFIF"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"rest-of-file"


class _Result(BaseModel):
    answer: str


class FakeAioModels:
    def __init__(self, response) -> None:
        self._response = response
        self.calls: list[dict] = []

    async def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        return self._response


def _fake_response(text: str, prompt_tokens: int = 10, output_tokens: int = 5):
    return SimpleNamespace(
        text=text,
        usage_metadata=SimpleNamespace(
            prompt_token_count=prompt_tokens, candidates_token_count=output_tokens
        ),
    )


def _make_client(response) -> tuple[GeminiVertexLlmClient, FakeAioModels]:
    client = GeminiVertexLlmClient.__new__(GeminiVertexLlmClient)  # bypass __init__/ADC entirely
    models = FakeAioModels(response)
    client._client = SimpleNamespace(aio=SimpleNamespace(models=models))
    return client, models


def test_sniff_media_type_detects_jpeg():
    assert _sniff_media_type(JPEG_MAGIC) == "image/jpeg"


def test_sniff_media_type_detects_png():
    assert _sniff_media_type(PNG_MAGIC) == "image/png"


def test_sniff_media_type_rejects_unrecognized_bytes():
    with pytest.raises(ValueError, match="unrecognized image format"):
        _sniff_media_type(b"not-an-image-at-all")


async def test_no_images_sends_plain_string_content_unchanged():
    client, models = _make_client(_fake_response('{"answer": "yes"}'))

    result, usage = await client.complete_structured(
        model="gemini-2.5-pro", system="sys", user_content="plain text prompt", schema=_Result
    )

    assert result.answer == "yes"
    assert usage == LlmUsage(input_tokens=10, output_tokens=5, model="gemini-2.5-pro")
    assert models.calls[0]["contents"] == ["plain text prompt"]
    assert models.calls[0]["config"].system_instruction == "sys"
    assert models.calls[0]["config"].response_schema is _Result
    assert models.calls[0]["config"].temperature == 0.0


async def test_temperature_is_forwarded():
    client, models = _make_client(_fake_response('{"answer": "yes"}'))

    await client.complete_structured(
        model="gemini-2.5-pro",
        system="sys",
        user_content="write prose",
        schema=_Result,
        temperature=0.25,
    )

    assert models.calls[0]["config"].temperature == 0.25


async def test_images_are_sent_before_the_text_content():
    client, models = _make_client(_fake_response('{"answer": "a slide"}'))

    await client.complete_structured(
        model="gemini-2.5-flash-lite",
        system="sys",
        user_content="Caption this screenshot.",
        schema=_Result,
        images=[JPEG_MAGIC],
    )

    contents = models.calls[0]["contents"]
    assert len(contents) == 2
    assert contents[1] == "Caption this screenshot."
    # contents[0] is a google.genai.types.Part built from JPEG_MAGIC -- just
    # confirm it isn't the plain text and that only one image was attached.


async def test_multiple_images_all_precede_the_single_text_entry():
    client, models = _make_client(_fake_response('{"answer": "two frames"}'))

    await client.complete_structured(
        model="gemini-2.5-flash-lite",
        system="sys",
        user_content="Compare these two screenshots.",
        schema=_Result,
        images=[JPEG_MAGIC, PNG_MAGIC],
    )

    contents = models.calls[0]["contents"]
    assert len(contents) == 3
    assert contents[2] == "Compare these two screenshots."
