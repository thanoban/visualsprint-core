"""Unit coverage for app.adapters.asr_groq -- the locked English ASR vendor
(docs/04-asr.md). The real `groq` SDK is installed in this venv but never
touched here: transcribe_segment() takes an injectable `client`, so these
tests fake the one async call it makes and never hit the network."""

import asyncio

import pytest

from app.adapters.asr_common import VendorTranscriptionError
from app.adapters.asr_groq import GroqSpeechAdapter


class _FakeWord:
    def __init__(self, word, start, end):
        self.word = word
        self.start = start
        self.end = end


class _FakeSegment:
    def __init__(self, avg_logprob):
        self.avg_logprob = avg_logprob


class _FakeResponse:
    def __init__(self, text, words=None, segments=None):
        self.text = text
        self.words = words or []
        self.segments = segments or []


class _FakeTranscriptions:
    def __init__(self, outcome):
        self._outcome = outcome
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


class _FakeAudio:
    def __init__(self, outcome):
        self.transcriptions = _FakeTranscriptions(outcome)


class _FakeGroqClient:
    def __init__(self, outcome):
        self.audio = _FakeAudio(outcome)


def test_provider_name_includes_the_locked_model():
    adapter = GroqSpeechAdapter(client=_FakeGroqClient(_FakeResponse("")))
    assert adapter.provider_name() == "groq:whisper-large-v3-turbo"


async def test_rejects_a_non_english_lang_hint():
    adapter = GroqSpeechAdapter(client=_FakeGroqClient(_FakeResponse("")))
    with pytest.raises(ValueError, match="unsupported lang_hint"):
        await adapter.transcribe_segment(b"", "si")


async def test_normalizes_text_and_word_timings():
    response = _FakeResponse(
        "hello world",
        words=[_FakeWord("hello", 0.0, 0.4), _FakeWord("world", 0.5, 1.0)],
        segments=[_FakeSegment(avg_logprob=-0.1)],
    )
    adapter = GroqSpeechAdapter(client=_FakeGroqClient(response))

    result = await adapter.transcribe_segment(b"raw-pcm", "en")

    assert result.text == "hello world"
    assert result.provider == "groq:whisper-large-v3-turbo"
    assert [w.text for w in result.words] == ["hello", "world"]
    assert result.words[1].start_s == 0.5
    assert 0.0 < result.confidence <= 1.0


async def test_empty_text_with_no_segments_yields_zero_confidence():
    adapter = GroqSpeechAdapter(client=_FakeGroqClient(_FakeResponse("")))

    result = await adapter.transcribe_segment(b"raw-pcm", "en")

    assert result.text == ""
    assert result.confidence == 0.0


async def test_vendor_timeout_is_wrapped_in_vendor_transcription_error():
    class _HangingTranscriptions(_FakeTranscriptions):
        async def create(self, **kwargs):
            await asyncio.sleep(10)

    client = _FakeGroqClient(_FakeResponse(""))
    client.audio.transcriptions = _HangingTranscriptions(_FakeResponse(""))
    adapter = GroqSpeechAdapter(timeout_s=0.01, client=client)

    with pytest.raises(VendorTranscriptionError, match="timed out"):
        await adapter.transcribe_segment(b"raw-pcm", "en")


async def test_vendor_sdk_error_is_wrapped_not_leaked():
    adapter = GroqSpeechAdapter(client=_FakeGroqClient(RuntimeError("groq 500")))

    with pytest.raises(VendorTranscriptionError, match="groq 500"):
        await adapter.transcribe_segment(b"raw-pcm", "en")


async def test_missing_api_key_raises_before_touching_the_network(monkeypatch):
    adapter = GroqSpeechAdapter()
    adapter._api_key = None

    with pytest.raises(VendorTranscriptionError, match="not configured"):
        await adapter.transcribe_segment(b"raw-pcm", "en")
