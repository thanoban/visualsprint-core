"""Unit coverage for app.adapters.asr_azure -- the locked si/ta fallback
vendor (docs/04-asr.md). Unlike the Google/Groq adapters, AzureSpeechAdapter
has no injectable client seam (the Azure Speech SDK's recognizer is
constructed inline in `_recognize_once`), so these tests monkeypatch that
one method directly and exercise `_normalize`/`_locale`/error-wrapping in
isolation. The real `azure-cognitiveservices-speech` package is installed
in this venv (used only for its ResultReason enum, never for real
recognition), so no network or subscription is touched."""

import azure.cognitiveservices.speech as speechsdk
import pytest

from app.adapters.asr_azure import AzureSpeechAdapter
from app.adapters.asr_common import VendorTranscriptionError


class _FakeResult:
    def __init__(self, reason, text="", json_payload=None):
        self.reason = reason
        self.text = text
        self.json = json_payload


def test_provider_name_uses_the_locked_locale_map():
    adapter = AzureSpeechAdapter()
    assert adapter.provider_name("si") == "azure:si-LK"
    assert adapter.provider_name("ta") == "azure:ta-IN"


def test_rejects_an_unsupported_lang_hint():
    adapter = AzureSpeechAdapter()
    with pytest.raises(ValueError, match="unsupported lang_hint"):
        adapter._locale("en")


async def test_normalizes_recognized_speech_into_words_and_confidence(monkeypatch):
    payload = (
        '{"NBest": [{"Confidence": 0.87, "Words": '
        '[{"Word": "kohomada", "Offset": 0, "Duration": 5000000}]}]}'
    )
    result = _FakeResult(speechsdk.ResultReason.RecognizedSpeech, text="kohomada", json_payload=payload)
    adapter = AzureSpeechAdapter()
    monkeypatch.setattr(adapter, "_recognize_once", lambda locale, audio_bytes: result)

    out = await adapter.transcribe_segment(b"raw-pcm", "si")

    assert out.text == "kohomada"
    assert out.provider == "azure:si-LK"
    assert out.confidence == 0.87
    assert out.words[0].text == "kohomada"
    assert out.words[0].end_s == 0.5


async def test_no_match_yields_an_empty_zero_confidence_result_not_an_error(monkeypatch):
    result = _FakeResult(speechsdk.ResultReason.NoMatch)
    adapter = AzureSpeechAdapter()
    monkeypatch.setattr(adapter, "_recognize_once", lambda locale, audio_bytes: result)

    out = await adapter.transcribe_segment(b"raw-pcm", "ta")

    assert out.text == ""
    assert out.words == []
    assert out.confidence == 0.0


async def test_recognition_failure_reason_raises_vendor_transcription_error(monkeypatch):
    result = _FakeResult(speechsdk.ResultReason.Canceled)
    adapter = AzureSpeechAdapter()
    monkeypatch.setattr(adapter, "_recognize_once", lambda locale, audio_bytes: result)

    with pytest.raises(VendorTranscriptionError, match="did not succeed"):
        await adapter.transcribe_segment(b"raw-pcm", "si")


async def test_vendor_timeout_is_wrapped_in_vendor_transcription_error(monkeypatch):
    def _slow_recognize(locale, audio_bytes):
        import time

        time.sleep(10)

    adapter = AzureSpeechAdapter(timeout_s=0.01)
    monkeypatch.setattr(adapter, "_recognize_once", _slow_recognize)

    with pytest.raises(VendorTranscriptionError, match="timed out"):
        await adapter.transcribe_segment(b"raw-pcm", "si")


async def test_sdk_error_from_recognize_once_is_wrapped_not_leaked(monkeypatch):
    def _boom(locale, audio_bytes):
        raise RuntimeError("azure 500")

    adapter = AzureSpeechAdapter()
    monkeypatch.setattr(adapter, "_recognize_once", _boom)

    with pytest.raises(VendorTranscriptionError, match="azure 500"):
        await adapter.transcribe_segment(b"raw-pcm", "si")


def test_missing_credentials_raise_before_touching_the_sdk(monkeypatch):
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.delenv("VS_AZURE_SPEECH_KEY", raising=False)
    monkeypatch.delenv("VS_AZURE_SPEECH_REGION", raising=False)
    try:
        adapter = AzureSpeechAdapter()
        with pytest.raises(VendorTranscriptionError, match="not configured"):
            adapter._recognize_once("si-LK", b"raw-pcm")
    finally:
        get_settings.cache_clear()
