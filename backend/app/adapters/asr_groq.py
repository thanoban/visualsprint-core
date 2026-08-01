"""Groq adapter — whisper-large-v3-turbo for English spans.

Locked English vendor (docs/04-asr.md): $0.036/hr. Never used for si/ta —
Whisper freezes its detected language after the first 30s and cannot
code-switch, which is exactly the gap Google/Azure routing exists to cover.
Auth via app.config.Settings.groq_api_key — never hardcoded.
"""

import asyncio
import io
import math

from app.adapters.asr_common import RawVendorResult, VendorTranscriptionError, VendorWord
from app.config import get_settings

MODEL = "whisper-large-v3-turbo"
_SUPPORTED_LANGS = {"en"}
DEFAULT_TIMEOUT_S = 30.0


class GroqSpeechAdapter:
    def __init__(self, timeout_s: float = DEFAULT_TIMEOUT_S, client: object | None = None) -> None:
        settings = get_settings()
        self._api_key = settings.groq_api_key
        self._timeout_s = timeout_s
        self._client = client

    def provider_name(self) -> str:
        return f"groq:{MODEL}"

    def _ensure_client(self):
        if self._client is not None:
            return self._client
        if not self._api_key:
            raise VendorTranscriptionError("groq api key not configured")
        from groq import AsyncGroq

        self._client = AsyncGroq(api_key=self._api_key)
        return self._client

    async def transcribe_segment(self, audio_bytes: bytes, lang_hint: str) -> RawVendorResult:
        if lang_hint not in _SUPPORTED_LANGS:
            raise ValueError(f"unsupported lang_hint for groq adapter: {lang_hint!r}")
        client = self._ensure_client()
        audio_file = io.BytesIO(audio_bytes)
        audio_file.name = "segment.wav"
        try:
            response = await asyncio.wait_for(
                client.audio.transcriptions.create(
                    model=MODEL,
                    file=audio_file,
                    language=lang_hint,
                    response_format="verbose_json",
                    timestamp_granularities=["word", "segment"],
                ),
                timeout=self._timeout_s,
            )
        except TimeoutError as exc:
            raise VendorTranscriptionError(
                f"groq {MODEL} timed out after {self._timeout_s}s"
            ) from exc
        except VendorTranscriptionError:
            raise
        except Exception as exc:
            raise VendorTranscriptionError(f"groq {MODEL} request failed: {exc}") from exc
        return _normalize(response, self.provider_name())


def _normalize(response, provider: str) -> RawVendorResult:
    text = getattr(response, "text", "") or ""
    words: list[VendorWord] = []
    for w in getattr(response, "words", None) or []:
        w_start = w.get("start") if isinstance(w, dict) else getattr(w, "start", 0.0)
        w_end = w.get("end") if isinstance(w, dict) else getattr(w, "end", 0.0)
        w_text = w.get("word") if isinstance(w, dict) else getattr(w, "word", "")
        words.append(
            VendorWord(text=w_text or "", start_s=float(w_start or 0.0), end_s=float(w_end or 0.0))
        )

    confidences: list[float] = []
    for seg in getattr(response, "segments", None) or []:
        avg_logprob = (
            seg.get("avg_logprob") if isinstance(seg, dict) else getattr(seg, "avg_logprob", None)
        )
        if avg_logprob is not None:
            confidences.append(_logprob_to_confidence(float(avg_logprob)))
    confidence = (
        sum(confidences) / len(confidences) if confidences else (1.0 if text.strip() else 0.0)
    )
    return RawVendorResult(text=text, words=words, confidence=confidence, provider=provider)


def _logprob_to_confidence(avg_logprob: float) -> float:
    """Whisper's verbose_json has no native confidence field; approximate from avg_logprob."""
    return max(0.0, min(1.0, math.exp(avg_logprob)))
