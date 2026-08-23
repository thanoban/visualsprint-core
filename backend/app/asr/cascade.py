"""ASR routing cascade — VAD → LID → per-language vendor dispatch → stitched transcript.

Conforms to the Transcriber protocol (app.interfaces.transcriber) so it is a
drop-in for orchestrator stage handlers. Vendor selection is locked in
docs/04-asr.md: Google chirp_2 primary / Azure fallback for si+ta with
auto-failover on error, timeout, empty text, or low confidence; Groq for en.
LLM repair (glossary/roster/OCR context) is a later stage, not this one —
this cascade's only job is getting a faithful per-vendor transcript stitched
back onto the original timeline.
"""

import logging
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from app.adapters.asr_azure import AzureSpeechAdapter
from app.adapters.asr_common import RawVendorResult, VendorTranscriptionError
from app.adapters.asr_google import GoogleSpeechAdapter
from app.adapters.asr_groq import GroqSpeechAdapter
from app.adapters.blobstore_local import LocalBlobStore
from app.asr.audio_io import slice_to_wav_bytes
from app.asr.lid import LabeledSpan, VoxLingua107LID
from app.asr.vad import SileroVAD
from app.interfaces.blobstore import BlobStore
from app.interfaces.transcriber import (
    Lang,
    TranscriptionRequest,
    TranscriptionResult,
    TranscriptSegment,
    TranscriptWord,
)

logger = logging.getLogger(__name__)

DEFAULT_MIN_CONFIDENCE = 0.6
UNROUTED_PROVIDER = "unrouted"
# Inline audio limit for chirp_2's synchronous Recognize API.  Anything
# longer must be chunked before being sent. Using 55s leaves a small margin.
_CHIRP2_MAX_CHUNK_S = 55.0


class _TimeChunkVAD:
    """VAD stub that skips torch/Silero entirely.  Splits audio into fixed-
    length chunks that fit within chirp_2's inline-audio limit.  Correct for
    multilingual bot captures — VAD-derived boundaries are not needed when the
    whole chunk goes to a multilingual recogniser that does its own VAD."""

    def detect_speech_spans(self, audio_path: str) -> list[tuple[float, float]]:
        from app.asr.audio_io import duration_s

        dur = duration_s(audio_path)
        spans: list[tuple[float, float]] = []
        cursor = 0.0
        while cursor < dur - 1e-6:
            spans.append((cursor, min(cursor + _CHIRP2_MAX_CHUNK_S, dur)))
            cursor += _CHIRP2_MAX_CHUNK_S
        return spans or [(0.0, dur)]


class _UnknownLID:
    """LID stub that skips speechbrain/VoxLingua107 entirely.  Returns every
    span as UNKNOWN so the cascade routes all audio to the multilingual chirp_2
    path, which is actually more correct for code-switching audio."""

    def label_language(
        self, audio_path: str, spans: list[tuple[float, float]]
    ) -> list["LabeledSpan"]:
        return [
            LabeledSpan(start_s=s, end_s=e, lang=Lang.UNKNOWN, confidence=1.0)
            for s, e in spans
        ]


class TranscriptionCascade:
    """Router + stitcher. Satisfies the `Transcriber` Protocol."""

    def __init__(
        self,
        vad: SileroVAD | None = None,
        lid: VoxLingua107LID | None = None,
        google: GoogleSpeechAdapter | None = None,
        azure: AzureSpeechAdapter | None = None,
        groq: GroqSpeechAdapter | None = None,
        blob_store: BlobStore | None = None,
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    ) -> None:
        self._vad = vad or SileroVAD()
        self._lid = lid or VoxLingua107LID()
        self._google = google or GoogleSpeechAdapter()
        self._azure = azure or AzureSpeechAdapter()
        self._groq = groq or GroqSpeechAdapter()
        self._blob_store = blob_store
        self._min_confidence = min_confidence

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        segments: list[TranscriptSegment] = []
        providers_used: set[str] = set()
        failovers = 0

        async with self._materialize_audio(request.audio_uri) as audio_path:
            spans = self._vad.detect_speech_spans(audio_path)
            labeled_spans = self._lid.label_language(audio_path, spans)
            for span in labeled_spans:
                segment, span_providers, failed_over = await self._transcribe_span(audio_path, span)
                segments.append(segment)
                providers_used.update(span_providers)
                if failed_over:
                    failovers += 1

        segments.sort(key=lambda s: s.start_s)
        return TranscriptionResult(
            segments=segments, providers_used=sorted(providers_used), failovers=failovers
        )

    async def _transcribe_span(
        self, audio_path: str, span: LabeledSpan
    ) -> tuple[TranscriptSegment, set[str], bool]:
        if span.lang == Lang.EN:
            return await self._transcribe_english(audio_path, span)
        if span.lang in (Lang.SI, Lang.TA):
            return await self._transcribe_si_ta(audio_path, span)
        if span.lang == Lang.UNKNOWN:
            return await self._transcribe_multilingual(audio_path, span)
        return self._unrouted_segment(span), set(), False

    async def _transcribe_english(
        self, audio_path: str, span: LabeledSpan
    ) -> tuple[TranscriptSegment, set[str], bool]:
        audio_bytes = slice_to_wav_bytes(audio_path, span.start_s, span.end_s)
        provider = self._groq.provider_name()
        try:
            result = await self._groq.transcribe_segment(audio_bytes, "en")
        except VendorTranscriptionError as exc:
            logger.warning("groq failed for span %.2f-%.2f: %s", span.start_s, span.end_s, exc)
            return self._failed_segment(span, provider), {provider}, False
        return _to_segment(span, result), {result.provider}, False

    async def _transcribe_si_ta(
        self, audio_path: str, span: LabeledSpan
    ) -> tuple[TranscriptSegment, set[str], bool]:
        audio_bytes = slice_to_wav_bytes(audio_path, span.start_s, span.end_s)
        lang_hint = span.lang.value
        google_provider = self._google.provider_name(lang_hint)
        azure_provider = self._azure.provider_name(lang_hint)
        providers_used: set[str] = set()

        primary = await self._try_vendor(self._google, audio_bytes, lang_hint)
        providers_used.add(google_provider)
        if primary is not None and self._is_acceptable(primary):
            return _to_segment(span, primary), providers_used, False

        fallback = await self._try_vendor(self._azure, audio_bytes, lang_hint)
        providers_used.add(azure_provider)
        if fallback is not None and self._is_acceptable(fallback):
            return _to_segment(span, fallback), providers_used, True

        best = fallback or primary
        if best is not None:
            return _to_segment(span, best), providers_used, True
        return self._failed_segment(span, azure_provider), providers_used, True

    async def _transcribe_multilingual(
        self, audio_path: str, span: LabeledSpan
    ) -> tuple[TranscriptSegment, set[str], bool]:
        """chirp_2 with all three language codes — handles code-switching
        without needing LID.  Falls back to an empty segment on total failure
        so the pipeline continues rather than crashing."""
        audio_bytes = slice_to_wav_bytes(audio_path, span.start_s, span.end_s)
        provider = "google:chirp_2:multilingual"
        try:
            result = await self._google.transcribe_multilingual(audio_bytes)
        except Exception as exc:
            logger.warning(
                "multilingual chirp_2 failed for span %.2f-%.2f: %s",
                span.start_s, span.end_s, exc,
            )
            return self._failed_segment(span, provider), {provider}, False
        return _to_segment(span, result), {result.provider}, False

    async def _try_vendor(
        self, adapter, audio_bytes: bytes, lang_hint: str
    ) -> RawVendorResult | None:
        try:
            return await adapter.transcribe_segment(audio_bytes, lang_hint)
        except VendorTranscriptionError as exc:
            logger.warning("%s failed for lang=%s: %s", type(adapter).__name__, lang_hint, exc)
            return None

    def _is_acceptable(self, result: RawVendorResult) -> bool:
        return bool(result.text.strip()) and result.confidence >= self._min_confidence

    def _unrouted_segment(self, span: LabeledSpan) -> TranscriptSegment:
        return self._failed_segment(span, UNROUTED_PROVIDER)

    def _failed_segment(self, span: LabeledSpan, provider: str) -> TranscriptSegment:
        return TranscriptSegment(
            start_s=span.start_s,
            end_s=span.end_s,
            text="",
            words=[],
            lang_tags=[span.lang],
            asr_confidence=0.0,
            provider=provider,
        )

    @asynccontextmanager
    async def _materialize_audio(self, audio_uri: str) -> AsyncIterator[str]:
        local_path = Path(audio_uri)
        if local_path.exists():
            yield str(local_path)
            return

        blob_store = self._blob_store or LocalBlobStore()
        data = await blob_store.get(audio_uri)
        suffix = Path(audio_uri).suffix or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        try:
            yield tmp_path
        finally:
            Path(tmp_path).unlink(missing_ok=True)


def _to_segment(span: LabeledSpan, result: RawVendorResult) -> TranscriptSegment:
    words = [
        TranscriptWord(
            text=w.text,
            start_s=span.start_s + w.start_s,
            end_s=span.start_s + w.end_s,
            lang=span.lang,
            confidence=w.confidence,
        )
        for w in result.words
    ]
    return TranscriptSegment(
        start_s=span.start_s,
        end_s=span.end_s,
        text=result.text,
        words=words,
        lang_tags=[span.lang],
        asr_confidence=result.confidence,
        provider=result.provider,
    )
