"""Unit coverage for app.adapters.asr_google -- the locked primary si/ta
vendor (docs/04-asr.md). The real class is never exercised elsewhere:
tests/scripts/test_generate_asr_hypotheses.py monkeypatches
GoogleSpeechAdapter out entirely. transcribe_segment() takes an injectable
`client`, so these tests fake the one async call it makes and never hit
GCP or need service-account credentials."""

from datetime import timedelta

import pytest

from app.adapters.asr_common import VendorTranscriptionError
from app.adapters.asr_google import GoogleSpeechAdapter


class _FakeWord:
    def __init__(self, word, start_s, end_s, confidence):
        self.word = word
        self.start_offset = timedelta(seconds=start_s)
        self.end_offset = timedelta(seconds=end_s)
        self.confidence = confidence


class _FakeAlternative:
    def __init__(self, transcript, confidence=0.9, words=None):
        self.transcript = transcript
        self.confidence = confidence
        self.words = words or []


class _FakeResult:
    def __init__(self, alternatives):
        self.alternatives = alternatives


class _FakeResponse:
    def __init__(self, results):
        self.results = results


class _FakeClient:
    def __init__(self, outcome):
        self._outcome = outcome
        self.calls: list = []

    async def recognize(self, request):
        self.calls.append(request)
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


def test_provider_name_encodes_model_and_locale():
    adapter = GoogleSpeechAdapter(client=_FakeClient(_FakeResponse([])))
    assert adapter.provider_name("si") == "google:chirp_2:si-LK"
    assert adapter.provider_name("ta") == "google:chirp_2:ta-IN"


async def test_rejects_an_unsupported_lang_hint():
    adapter = GoogleSpeechAdapter(client=_FakeClient(_FakeResponse([])))
    with pytest.raises(ValueError, match="unsupported lang_hint"):
        await adapter.transcribe_segment(b"", "en")


async def test_normalizes_transcript_words_and_confidence():
    response = _FakeResponse(
        [
            _FakeResult(
                [
                    _FakeAlternative(
                        "kohomada",
                        confidence=0.92,
                        words=[_FakeWord("kohomada", 0.0, 0.6, 0.92)],
                    )
                ]
            )
        ]
    )
    adapter = GoogleSpeechAdapter(client=_FakeClient(response))

    result = await adapter.transcribe_segment(b"raw-pcm", "si")

    assert result.text == "kohomada"
    assert result.provider == "google:chirp_2:si-LK"
    assert result.confidence == pytest.approx(0.92)
    assert result.words[0].text == "kohomada"
    assert result.words[0].end_s == pytest.approx(0.6)


async def test_skips_results_with_no_alternatives():
    response = _FakeResponse([_FakeResult([]), _FakeResult([_FakeAlternative("eka", confidence=0.8)])])
    adapter = GoogleSpeechAdapter(client=_FakeClient(response))

    result = await adapter.transcribe_segment(b"raw-pcm", "ta")

    assert result.text == "eka"


async def test_empty_results_yield_empty_text_and_zero_confidence():
    adapter = GoogleSpeechAdapter(client=_FakeClient(_FakeResponse([])))

    result = await adapter.transcribe_segment(b"raw-pcm", "si")

    assert result.text == ""
    assert result.confidence == 0.0


async def test_vendor_timeout_is_wrapped_in_vendor_transcription_error():
    class _HangingClient(_FakeClient):
        async def recognize(self, request):
            import asyncio

            await asyncio.sleep(10)

    adapter = GoogleSpeechAdapter(timeout_s=0.01, client=_HangingClient(_FakeResponse([])))

    with pytest.raises(VendorTranscriptionError, match="timed out"):
        await adapter.transcribe_segment(b"raw-pcm", "si")


async def test_vendor_sdk_error_is_wrapped_not_leaked():
    adapter = GoogleSpeechAdapter(client=_FakeClient(RuntimeError("grpc unavailable")))

    with pytest.raises(VendorTranscriptionError, match="grpc unavailable"):
        await adapter.transcribe_segment(b"raw-pcm", "si")
