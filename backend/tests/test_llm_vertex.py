"""Tests for VertexLlmClient's image-content-block construction -- the
genuinely new logic added for VLM captioning (app/adapters/vlm_caption.py).
Bypasses __init__ (which resolves a real GCP project via Application
Default Credentials) by constructing the instance directly and injecting a
fake `_client`, so this needs no live GCP credentials to run.
"""

from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from app.adapters.llm_vertex import VertexLlmClient, _sniff_media_type
from app.interfaces.llm import LlmUsage

JPEG_MAGIC = b"\xff\xd8\xff\xe0\x00\x10JFIF"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"rest-of-file"


class _Result(BaseModel):
    answer: str


class FakeMessages:
    def __init__(self, response) -> None:
        self._response = response
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._response


def _fake_tool_use_response(input_data: dict):
    tool_block = SimpleNamespace(type="tool_use", input=input_data)
    return SimpleNamespace(
        content=[tool_block], usage=SimpleNamespace(input_tokens=10, output_tokens=5)
    )


def _make_client(response) -> tuple[VertexLlmClient, FakeMessages]:
    client = VertexLlmClient.__new__(VertexLlmClient)  # bypass __init__/ADC entirely
    messages = FakeMessages(response)
    client._client = SimpleNamespace(messages=messages)
    return client, messages


def test_sniff_media_type_detects_jpeg():
    assert _sniff_media_type(JPEG_MAGIC) == "image/jpeg"


def test_sniff_media_type_detects_png():
    assert _sniff_media_type(PNG_MAGIC) == "image/png"


def test_sniff_media_type_rejects_unrecognized_bytes():
    with pytest.raises(ValueError, match="unrecognized image format"):
        _sniff_media_type(b"not-an-image-at-all")


async def test_no_images_sends_plain_string_content_unchanged():
    """The overwhelming majority of call sites (all five agents, the repair
    pass) never pass images -- this path must be byte-for-byte what it was
    before images existed, not a new list-wrapped shape."""
    client, messages = _make_client(_fake_tool_use_response({"answer": "yes"}))

    result, usage = await client.complete_structured(
        model="claude-sonnet-5", system="sys", user_content="plain text prompt", schema=_Result
    )

    assert result.answer == "yes"
    assert usage == LlmUsage(input_tokens=10, output_tokens=5, model="claude-sonnet-5")
    sent_messages = messages.calls[0]["messages"]
    assert sent_messages == [{"role": "user", "content": "plain text prompt"}]


async def test_images_are_sent_before_the_text_block():
    client, messages = _make_client(_fake_tool_use_response({"answer": "a slide"}))

    await client.complete_structured(
        model="claude-haiku-4-5-20251001",
        system="sys",
        user_content="Caption this screenshot.",
        schema=_Result,
        images=[JPEG_MAGIC],
    )

    content = messages.calls[0]["messages"][0]["content"]
    assert isinstance(content, list)
    assert content[0]["type"] == "image"
    assert content[0]["source"]["media_type"] == "image/jpeg"
    assert content[1] == {"type": "text", "text": "Caption this screenshot."}


async def test_multiple_images_all_precede_the_single_text_block():
    client, messages = _make_client(_fake_tool_use_response({"answer": "two frames"}))

    await client.complete_structured(
        model="claude-haiku-4-5-20251001",
        system="sys",
        user_content="Compare these two screenshots.",
        schema=_Result,
        images=[JPEG_MAGIC, PNG_MAGIC],
    )

    content = messages.calls[0]["messages"][0]["content"]
    assert len(content) == 3
    assert content[0]["source"]["media_type"] == "image/jpeg"
    assert content[1]["source"]["media_type"] == "image/png"
    assert content[2]["type"] == "text"


async def test_image_bytes_are_base64_encoded_not_sent_raw():
    import base64

    client, messages = _make_client(_fake_tool_use_response({"answer": "x"}))

    await client.complete_structured(
        model="claude-haiku-4-5-20251001",
        system="sys",
        user_content="x",
        schema=_Result,
        images=[JPEG_MAGIC],
    )

    content = messages.calls[0]["messages"][0]["content"]
    encoded = content[0]["source"]["data"]
    assert base64.b64decode(encoded) == JPEG_MAGIC
