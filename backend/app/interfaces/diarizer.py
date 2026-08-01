"""Diarizer swap point. Bought today: pyannote. Owned later: custom fusion.

Only needed for mixed-audio modes (Meet/Teams artifacts, bot, desktop, upload).
Zoom per-participant audio skips diarization entirely — attribution is exact.
"""

from typing import Protocol

from pydantic import BaseModel, Field


class SpeakerTurn(BaseModel):
    start_s: float
    end_s: float
    cluster_id: str  # anonymous, e.g. "SPEAKER_00" — identity fusion maps to person later
    confidence: float = Field(ge=0.0, le=1.0, default=1.0)


class DiarizationResult(BaseModel):
    turns: list[SpeakerTurn]
    num_speakers: int


class Diarizer(Protocol):
    async def diarize(self, audio_uri: str, min_speakers: int = 1, max_speakers: int = 20) -> DiarizationResult: ...
