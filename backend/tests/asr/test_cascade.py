"""Cascade routing + auto-failover — the highest-value logic in the ASR
track (docs/04-asr.md): Google primary / Azure fallback for si/ta with
failover on error/empty/low-confidence, Groq for en. Fakes VAD/LID/vendor
backends entirely so this needs no torch, no speechbrain, no vendor creds.
"""

import numpy as np
import pytest
import soundfile as sf

from app.adapters.asr_common import RawVendorResult, VendorTranscriptionError, VendorWord
from app.asr.cascade import TranscriptionCascade
from app.asr.lid import LabeledSpan
from app.interfaces.transcriber import Lang, TranscriptionRequest


@pytest.fixture
def silence_wav(tmp_path) -> str:
    path = str(tmp_path / "meeting.wav")
    sf.write(path, np.zeros(16_000 * 2, dtype=np.float32), 16_000)
    return path


class FakeVad:
    def __init__(self, spans: list[tuple[float, float]]) -> None:
        self._spans = spans

    def detect_speech_spans(self, audio_path: str) -> list[tuple[float, float]]:
        return self._spans


class FakeLid:
    def __init__(self, labeled: list[LabeledSpan]) -> None:
        self._labeled = labeled

    def label_language(self, audio_path: str, spans) -> list[LabeledSpan]:
        return self._labeled


class FakeVendor:
    """Scriptable stand-in for GoogleSpeechAdapter/AzureSpeechAdapter/GroqSpeechAdapter."""

    def __init__(self, name: str, outcome):
        self._name = name
        self._outcome = outcome  # RawVendorResult | Exception
        self.calls = 0

    def provider_name(self, lang_hint: str | None = None) -> str:
        return self._name

    async def transcribe_segment(self, audio_bytes: bytes, lang_hint: str) -> RawVendorResult:
        self.calls += 1
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


def _result(text: str, provider: str, confidence: float = 0.95) -> RawVendorResult:
    return RawVendorResult(
        text=text,
        words=[VendorWord(text=text, start_s=0.0, end_s=1.0, confidence=confidence)],
        confidence=confidence,
        provider=provider,
    )


def _si_result(text: str, confidence: float = 0.95) -> RawVendorResult:
    return _result(text, "fake:si", confidence)


async def test_google_primary_succeeds_no_failover(silence_wav):
    span = LabeledSpan(start_s=0.0, end_s=1.0, lang=Lang.SI, confidence=0.9)
    google = FakeVendor("google:chirp_2:si-LK", _result("mage nama Kasun", "google:chirp_2:si-LK"))
    azure = FakeVendor("azure:si-LK", _result("should not be called", "azure:si-LK"))
    cascade = TranscriptionCascade(
        vad=FakeVad([(0.0, 1.0)]),
        lid=FakeLid([span]),
        google=google,
        azure=azure,
        groq=FakeVendor("groq", _si_result("n/a")),
    )

    result = await cascade.transcribe(TranscriptionRequest(audio_uri=silence_wav, org_id="org1"))

    assert result.failovers == 0
    assert google.calls == 1
    assert azure.calls == 0
    assert result.segments[0].text == "mage nama Kasun"
    assert result.segments[0].provider == "google:chirp_2:si-LK"


async def test_google_fails_azure_fallback_succeeds(silence_wav):
    span = LabeledSpan(start_s=0.0, end_s=1.0, lang=Lang.TA, confidence=0.9)
    google = FakeVendor("google:chirp_2:ta-IN", VendorTranscriptionError("quota exceeded"))
    azure = FakeVendor("azure:ta-IN", _result("vanakkam", "azure:ta-IN"))
    cascade = TranscriptionCascade(
        vad=FakeVad([(0.0, 1.0)]),
        lid=FakeLid([span]),
        google=google,
        azure=azure,
        groq=FakeVendor("groq", _si_result("n/a")),
    )

    result = await cascade.transcribe(TranscriptionRequest(audio_uri=silence_wav, org_id="org1"))

    assert result.failovers == 1
    assert google.calls == 1
    assert azure.calls == 1
    assert result.segments[0].text == "vanakkam"
    assert result.segments[0].provider == "azure:ta-IN"
    assert "azure:ta-IN" in result.providers_used
    assert "google:chirp_2:ta-IN" in result.providers_used


async def test_low_confidence_primary_still_triggers_failover(silence_wav):
    """Below min_confidence counts as unacceptable even without an exception."""
    span = LabeledSpan(start_s=0.0, end_s=1.0, lang=Lang.SI, confidence=0.9)
    google = FakeVendor("google:chirp_2:si-LK", _si_result("garbled", confidence=0.1))
    azure = FakeVendor("azure:si-LK", _si_result("clear text", confidence=0.9))
    cascade = TranscriptionCascade(
        vad=FakeVad([(0.0, 1.0)]),
        lid=FakeLid([span]),
        google=google,
        azure=azure,
        groq=FakeVendor("groq", _si_result("n/a")),
    )

    result = await cascade.transcribe(TranscriptionRequest(audio_uri=silence_wav, org_id="org1"))

    assert result.failovers == 1
    assert result.segments[0].text == "clear text"


async def test_both_vendors_fail_yields_empty_failed_segment(silence_wav):
    span = LabeledSpan(start_s=0.0, end_s=1.0, lang=Lang.SI, confidence=0.9)
    google = FakeVendor("google:chirp_2:si-LK", VendorTranscriptionError("down"))
    azure = FakeVendor("azure:si-LK", VendorTranscriptionError("down"))
    cascade = TranscriptionCascade(
        vad=FakeVad([(0.0, 1.0)]),
        lid=FakeLid([span]),
        google=google,
        azure=azure,
        groq=FakeVendor("groq", _si_result("n/a")),
    )

    result = await cascade.transcribe(TranscriptionRequest(audio_uri=silence_wav, org_id="org1"))

    assert result.segments[0].text == ""
    assert result.segments[0].asr_confidence == 0.0


async def test_english_span_routes_to_groq_only(silence_wav):
    span = LabeledSpan(start_s=0.0, end_s=1.0, lang=Lang.EN, confidence=0.9)
    google = FakeVendor("google", _si_result("should not be called"))
    azure = FakeVendor("azure", _si_result("should not be called"))
    groq = FakeVendor("groq:whisper-v3-turbo", _si_result("this is blocking the release"))
    cascade = TranscriptionCascade(
        vad=FakeVad([(0.0, 1.0)]), lid=FakeLid([span]), google=google, azure=azure, groq=groq
    )

    result = await cascade.transcribe(TranscriptionRequest(audio_uri=silence_wav, org_id="org1"))

    assert google.calls == 0
    assert azure.calls == 0
    assert groq.calls == 1
    assert result.segments[0].text == "this is blocking the release"


async def test_code_switched_meeting_stitches_segments_in_order(silence_wav):
    """The product's headline scenario: si -> en -> ta in one utterance stream."""
    spans = [
        LabeledSpan(start_s=0.0, end_s=1.0, lang=Lang.SI, confidence=0.9),
        LabeledSpan(start_s=1.0, end_s=2.0, lang=Lang.EN, confidence=0.9),
        LabeledSpan(start_s=2.0, end_s=3.0, lang=Lang.TA, confidence=0.9),
    ]
    google = FakeVendor("google", _si_result("deploy karanna"))
    azure = FakeVendor("azure", _si_result("n/a"))
    groq = FakeVendor("groq", _si_result("is ready but"))
    cascade = TranscriptionCascade(
        vad=FakeVad([(0.0, 3.0)]), lid=FakeLid(spans), google=google, azure=azure, groq=groq
    )

    result = await cascade.transcribe(TranscriptionRequest(audio_uri=silence_wav, org_id="org1"))

    assert [s.start_s for s in result.segments] == [0.0, 1.0, 2.0]
    assert google.calls == 2  # si + ta both routed to google (azure not needed)
    assert groq.calls == 1
