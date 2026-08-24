"""Google Cloud Speech-to-Text v2 adapter — chirp_2 model, si-LK/ta-IN locales.

Locked primary vendor for Sinhala/Tamil (docs/04-asr.md). Auth via ADC or
app.config.Settings.google_credentials_json — never hardcoded.
"""

import asyncio
from typing import Any

from app.adapters.asr_common import RawVendorResult, VendorTranscriptionError, VendorWord
from app.config import get_settings

MODEL = "chirp_2"
_LOCALE_MAP = {"si": "si-LK", "ta": "ta-IN"}
# chirp_2 supports up to 10 language codes simultaneously — used for
# multilingual/code-switching audio where the language is not pre-determined.
MULTILINGUAL_LOCALES = ["si-LK", "ta-IN", "en-US"]
DEFAULT_TIMEOUT_S = 60.0


class GoogleSpeechAdapter:
    def __init__(
        self,
        project_id: str = "-",
        timeout_s: float = DEFAULT_TIMEOUT_S,
        client: object | None = None,
    ) -> None:
        settings = get_settings()
        self._credentials_path = settings.google_credentials_json
        self._project_id = project_id
        self._timeout_s = timeout_s
        self._client = client

    def provider_name(self, lang_hint: str) -> str:
        return f"google:{MODEL}:{self._locale(lang_hint)}"

    def _locale(self, lang_hint: str) -> str:
        locale = _LOCALE_MAP.get(lang_hint)
        if locale is None:
            raise ValueError(f"unsupported lang_hint for google adapter: {lang_hint!r}")
        return locale

    def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        from google.cloud.speech_v2 import SpeechAsyncClient

        if self._credentials_path:
            from google.oauth2 import service_account

            credentials = service_account.Credentials.from_service_account_file(  # type: ignore[no-untyped-call]
                self._credentials_path
            )
            self._client = SpeechAsyncClient(credentials=credentials)
        else:
            self._client = SpeechAsyncClient()
        return self._client

    async def transcribe_segment(self, audio_bytes: bytes, lang_hint: str) -> RawVendorResult:
        locale = self._locale(lang_hint)
        return await self._recognize(audio_bytes, [locale], self.provider_name(lang_hint))

    async def transcribe_multilingual(self, audio_bytes: bytes) -> RawVendorResult:
        """Send audio to chirp_2 with all supported locales simultaneously.
        chirp_2 auto-selects the correct language per segment, making this
        correct for code-switching audio without needing local LID inference."""
        provider = f"google:{MODEL}:multilingual"
        return await self._recognize(audio_bytes, MULTILINGUAL_LOCALES, provider)

    async def _recognize(
        self, audio_bytes: bytes, language_codes: list[str], provider: str
    ) -> RawVendorResult:
        client = self._ensure_client()
        from google.cloud.speech_v2.types import cloud_speech

        config = cloud_speech.RecognitionConfig(
            auto_decoding_config=cloud_speech.AutoDetectDecodingConfig(),
            language_codes=language_codes,
            model=MODEL,
            features=cloud_speech.RecognitionFeatures(
                enable_word_time_offsets=True,
                enable_word_confidence=True,
            ),
        )
        request = cloud_speech.RecognizeRequest(
            recognizer=f"projects/{self._project_id}/locations/global/recognizers/_",
            config=config,
            content=audio_bytes,
        )
        label = ",".join(language_codes)
        try:
            response = await asyncio.wait_for(
                client.recognize(request=request), timeout=self._timeout_s
            )
        except TimeoutError as exc:
            raise VendorTranscriptionError(
                f"google {MODEL}/{label} timed out after {self._timeout_s}s"
            ) from exc
        except Exception as exc:
            raise VendorTranscriptionError(
                f"google {MODEL}/{label} request failed: {exc}"
            ) from exc
        return _normalize(response, provider)


def _normalize(response: Any, provider: str) -> RawVendorResult:
    texts: list[str] = []
    words: list[VendorWord] = []
    confidences: list[float] = []
    for result in response.results:
        if not result.alternatives:
            continue
        alt = result.alternatives[0]
        if alt.transcript:
            texts.append(alt.transcript)
        confidences.append(float(getattr(alt, "confidence", 0.0) or 0.0))
        for w in getattr(alt, "words", []) or []:
            words.append(
                VendorWord(
                    text=w.word,
                    start_s=w.start_offset.total_seconds() if w.start_offset else 0.0,
                    end_s=w.end_offset.total_seconds() if w.end_offset else 0.0,
                    confidence=float(getattr(w, "confidence", 0.0) or 0.0),
                )
            )
    avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
    return RawVendorResult(
        text=" ".join(texts), words=words, confidence=avg_confidence, provider=provider
    )
