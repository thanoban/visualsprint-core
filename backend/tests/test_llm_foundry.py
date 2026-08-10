"""Tests for FoundryLlmClient -- mirrors tests/test_llm_vertex.py since both
implementations sit behind the same LlmClient Protocol and build an
identical forced-tool-use Messages API call. Bypasses __init__ (which
requires a real Foundry api_key/resource) by constructing the instance
directly and injecting a fake `_client`, so this needs no live Azure
credentials to run.
"""

from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from app.adapters.llm_foundry import FoundryLlmClient, _sniff_media_type
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


def _make_client(response) -> tuple[FoundryLlmClient, FakeMessages]:
    client = FoundryLlmClient.__new__(FoundryLlmClient)  # bypass __init__/real auth entirely
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


def test_requires_both_api_key_and_resource(monkeypatch):
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.delenv("VS_FOUNDRY_API_KEY", raising=False)
    monkeypatch.delenv("VS_FOUNDRY_RESOURCE", raising=False)
    try:
        with pytest.raises(RuntimeError, match="foundry_api_key and foundry_resource"):
            FoundryLlmClient()
    finally:
        get_settings.cache_clear()


async def test_no_images_sends_plain_string_content_unchanged():
    """The overwhelming majority of call sites (all five agents, the repair
    pass) never pass images -- this path must be byte-for-byte the same
    shape as VertexLlmClient's, since the two are meant to be swappable."""
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


async def test_schema_invalid_output_raises_after_retries():
    client, messages = _make_client(_fake_tool_use_response({"wrong_field": "oops"}))

    from app.adapters.llm_foundry import SchemaValidationError

    with pytest.raises(SchemaValidationError):
        await client.complete_structured(
            model="claude-sonnet-5", system="sys", user_content="x", schema=_Result
        )
    assert len(messages.calls) == 3  # stop_after_attempt(3)


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
