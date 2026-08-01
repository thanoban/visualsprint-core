"""Diarizer implementation — pyannote.audio speaker-diarization pipeline.

Only used for mixed-audio capture modes (Meet/Teams artifacts, bot, desktop
upload) — Zoom per-participant audio skips diarization entirely, attribution
is exact (see app/interfaces/diarizer.py). pyannote's pretrained pipelines
are gated on Hugging Face: the caller must have accepted the model's terms
and provide a token (`VS_HUGGINGFACE_TOKEN`, read via `app.config.Settings`)
or every call raises.

Real inference lazy-loads pyannote.audio on first use only, so this module
(and unit tests that inject a fake backend) never requires network access or
even pyannote.audio to be installed.
"""

from __future__ import annotations

from typing import Protocol

from app.config import get_settings
from app.interfaces.diarizer import DiarizationResult, SpeakerTurn

DEFAULT_PIPELINE = "pyannote/speaker-diarization-3.1"

RawSpeakerTurn = tuple[float, float, str]  # start_s, end_s, cluster_label


class DiarizerModelBackend(Protocol):
    def run(self, audio_path: str, min_speakers: int, max_speakers: int) -> list[RawSpeakerTurn]: ...


class _PyannoteBackend:
    def __init__(self, hf_token: str | None, pipeline_name: str = DEFAULT_PIPELINE) -> None:
        self._hf_token = hf_token
        self._pipeline_name = pipeline_name
        self._pipeline = None

    def _ensure_loaded(self) -> None:
        if self._pipeline is not None:
            return
        if not self._hf_token:
            raise RuntimeError(
                "huggingface_token not set (VS_HUGGINGFACE_TOKEN) — pyannote's "
                "pretrained pipelines are gated on Hugging Face and require an "
                "accepted-terms access token"
            )
        from pyannote.audio import Pipeline

        self._pipeline = Pipeline.from_pretrained(self._pipeline_name, use_auth_token=self._hf_token)

    def run(self, audio_path: str, min_speakers: int, max_speakers: int) -> list[RawSpeakerTurn]:
        self._ensure_loaded()
        annotation = self._pipeline(audio_path, min_speakers=min_speakers, max_speakers=max_speakers)
        return [
            (float(segment.start), float(segment.end), str(label))
            for segment, _, label in annotation.itertracks(yield_label=True)
        ]


class PyannoteDiarizer:
    """`Diarizer` Protocol implementation backed by pyannote.audio."""

    def __init__(self, backend: DiarizerModelBackend | None = None, hf_token: str | None = None) -> None:
        token = hf_token if hf_token is not None else get_settings().huggingface_token
        self._backend = backend or _PyannoteBackend(hf_token=token)

    async def diarize(self, audio_uri: str, min_speakers: int = 1, max_speakers: int = 20) -> DiarizationResult:
        raw_turns = self._backend.run(audio_uri, min_speakers, max_speakers)
        turns = [
            SpeakerTurn(start_s=start, end_s=end, cluster_id=_normalize_cluster_id(label))
            for start, end, label in raw_turns
        ]
        num_speakers = len({turn.cluster_id for turn in turns})
        return DiarizationResult(turns=turns, num_speakers=num_speakers)


def _normalize_cluster_id(label: str) -> str:
    return label if label.upper().startswith("SPEAKER") else f"SPEAKER_{label}"
