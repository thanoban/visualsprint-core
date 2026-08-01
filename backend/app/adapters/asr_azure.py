"""Azure Cognitive Services Speech adapter — si-LK/ta-IN locales.

Locked fallback vendor for Sinhala/Tamil (docs/04-asr.md): the cascade
retries here whenever Google chirp_2 errors, times out, or returns a
low-confidence/empty result. Auth via app.config.Settings.azure_speech_key /
azure_speech_region — never hardcoded.
"""

import asyncio
import json
import tempfile
from pathlib import Path

from app.adapters.asr_common import RawVendorResult, VendorTranscriptionError, VendorWord
from app.config import get_settings

_LOCALE_MAP = {"si": "si-LK", "ta": "ta-IN"}
DEFAULT_TIMEOUT_S = 30.0
_TICKS_PER_SECOND = 10_000_000  # Azure offsets/durations are in 100-ns ticks


class AzureSpeechAdapter:
    def __init__(self, timeout_s: float = DEFAULT_TIMEOUT_S) -> None:
        settings = get_settings()
        self._speech_key = settings.azure_speech_key
        self._speech_region = settings.azure_speech_region
        self._timeout_s = timeout_s

    def provider_name(self, lang_hint: str) -> str:
        return f"azure:{self._locale(lang_hint)}"

    def _locale(self, lang_hint: str) -> str:
        locale = _LOCALE_MAP.get(lang_hint)
        if locale is None:
            raise ValueError(f"unsupported lang_hint for azure adapter: {lang_hint!r}")
        return locale

    async def transcribe_segment(self, audio_bytes: bytes, lang_hint: str) -> RawVendorResult:
        locale = self._locale(lang_hint)
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(self._recognize_once, locale, audio_bytes),
                timeout=self._timeout_s,
            )
        except TimeoutError as exc:
            raise VendorTranscriptionError(
                f"azure {locale} timed out after {self._timeout_s}s"
            ) from exc
        except VendorTranscriptionError:
            raise
        except Exception as exc:
            raise VendorTranscriptionError(f"azure {locale} request failed: {exc}") from exc
        return _normalize(result, self.provider_name(lang_hint))

    def _recognize_once(self, locale: str, audio_bytes: bytes):
        if not self._speech_key or not self._speech_region:
            raise VendorTranscriptionError("azure speech credentials not configured")
        import azure.cognitiveservices.speech as speechsdk

        speech_config = speechsdk.SpeechConfig(
            subscription=self._speech_key, region=self._speech_region
        )
        speech_config.speech_recognition_language = locale
        speech_config.output_format = speechsdk.OutputFormat.Detailed
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
        try:
            audio_config = speechsdk.audio.AudioConfig(filename=tmp_path)
            recognizer = speechsdk.SpeechRecognizer(
                speech_config=speech_config, audio_config=audio_config
            )
            return recognizer.recognize_once()
        finally:
            Path(tmp_path).unlink(missing_ok=True)


def _normalize(result, provider: str) -> RawVendorResult:
    import azure.cognitiveservices.speech as speechsdk

    if result.reason == speechsdk.ResultReason.NoMatch:
        return RawVendorResult(text="", words=[], confidence=0.0, provider=provider)
    if result.reason != speechsdk.ResultReason.RecognizedSpeech:
        raise VendorTranscriptionError(f"azure recognition did not succeed: reason={result.reason}")

    words: list[VendorWord] = []
    confidence = 0.0
    try:
        payload = json.loads(result.json) if getattr(result, "json", None) else {}
    except (TypeError, ValueError):
        payload = {}
    nbest = payload.get("NBest") or []
    if nbest:
        best = nbest[0]
        confidence = float(best.get("Confidence", 0.0))
        for w in best.get("Words", []):
            offset_ticks = w.get("Offset", 0)
            duration_ticks = w.get("Duration", 0)
            words.append(
                VendorWord(
                    text=w.get("Word", ""),
                    start_s=offset_ticks / _TICKS_PER_SECOND,
                    end_s=(offset_ticks + duration_ticks) / _TICKS_PER_SECOND,
                    confidence=confidence,
                )
            )
    return RawVendorResult(text=result.text, words=words, confidence=confidence, provider=provider)
