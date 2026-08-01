"""Transcriber swap point.

Bought today: the routing cascade (Google chirp_2 ⇄ Azure for si/ta with
auto-failover, Groq for en) + LLM repair. Owned later: fine-tuned CS model.
Downstream code must never know which implementation produced a segment.
"""

from enum import StrEnum
from typing import Protocol

from pydantic import BaseModel, Field


class Lang(StrEnum):
    SI = "si"
    TA = "ta"
    EN = "en"
    UNKNOWN = "und"


class TranscriptWord(BaseModel):
    text: str
    start_s: float
    end_s: float
    lang: Lang = Lang.UNKNOWN
    confidence: float = Field(ge=0.0, le=1.0, default=1.0)


class TranscriptSegment(BaseModel):
    """One contiguous span from one provider call, stitched by the cascade."""

    start_s: float
    end_s: float
    text: str
    words: list[TranscriptWord] = []
    lang_tags: list[Lang] = []
    asr_confidence: float = Field(ge=0.0, le=1.0, default=1.0)
    provider: str  # e.g. "google:chirp_2", "azure:si-LK", "groq:whisper-v3-turbo"


class TranscriptionRequest(BaseModel):
    audio_uri: str  # blob-store URI, 16 kHz mono FLAC/WAV
    org_id: str
    glossary_terms: list[str] = []  # per-org biasing lexicon (ticket IDs, names, tech terms)
    expected_langs: list[Lang] = [Lang.SI, Lang.TA, Lang.EN]


class TranscriptionResult(BaseModel):
    segments: list[TranscriptSegment]
    providers_used: list[str]
    failovers: int = 0  # times primary→fallback fired; feeds coverage/ops telemetry


class Transcriber(Protocol):
    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult: ...
