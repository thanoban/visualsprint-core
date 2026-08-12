"""SpeakerEmbedder implementation — pyannote/embedding.

Produces one 512-dim centroid per diarized cluster, which is what lets a
voice be recognised in next week's meeting (docs/08-speaker-identity.md
Phase B). The 512 was read from the real model's output shape, not from
documentation.

Audio is loaded with soundfile and handed to pyannote as an in-memory
waveform dict rather than a file path. pyannote's path-based `crop()`
requires torchcodec, an optional native dependency that is both easy to
break (platform-specific shared libraries) and unnecessary here — soundfile
is already a declared `asr` dependency and decodes the FLAC/WAV this
pipeline produces. Fewer native moving parts in the production image.

Same lazy-import and injectable-backend shape as diarizer_pyannote.py:
tests substitute a fake backend and never import pyannote.audio or torch.
"""

from __future__ import annotations

import math
from typing import Protocol

from app.config import get_settings
from app.interfaces.diarizer import SpeakerTurn

EMBEDDING_MODEL = "pyannote/embedding"

# Below this, a cluster's audio is too short for a stable voiceprint. A
# vector fitted to a fragment matches confidently against the wrong person,
# which is worse than declining to identify the speaker at all.
MIN_CLUSTER_SECONDS = 2.0


def _l2_normalize(vector: list[float]) -> list[float]:
    """Return a unit vector because pyannote/embedding emits raw magnitudes."""

    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0 or not math.isfinite(norm):
        raise ValueError("pyannote produced a zero or non-finite speaker embedding")
    normalized = [float(value / norm) for value in vector]
    if not all(math.isfinite(value) for value in normalized):
        raise ValueError("pyannote produced a non-finite speaker embedding")
    return normalized


class EmbeddingModelBackend(Protocol):
    def embed(self, audio_uri: str, spans: list[tuple[float, float]]) -> list[list[float]]:
        """One vector per (start_s, end_s) span, in the order given."""
        ...


class _PyannoteEmbeddingBackend:
    def __init__(self, hf_token: str | None, model_name: str = EMBEDDING_MODEL) -> None:
        self._hf_token = hf_token
        self._model_name = model_name
        self._inference = None

    def _ensure_loaded(self):
        if self._inference is not None:
            return self._inference
        if not self._hf_token:
            raise RuntimeError(
                "huggingface_token not set (VS_HUGGINGFACE_TOKEN) — pyannote's "
                "pretrained models are gated on Hugging Face and require an "
                "accepted-terms access token"
            )
        from pyannote.audio import Inference, Model

        # `token=`, not the older `use_auth_token=` — see the same note in
        # diarizer_pyannote.py; the old name raises rather than falling back.
        model = Model.from_pretrained(self._model_name, token=self._hf_token)
        self._inference = Inference(model, window="whole")
        return self._inference

    def embed(self, audio_uri: str, spans: list[tuple[float, float]]) -> list[list[float]]:
        import soundfile as sf
        import torch
        from pyannote.core import Segment

        inference = self._ensure_loaded()
        data, sample_rate = sf.read(audio_uri, dtype="float32", always_2d=True)
        waveform = torch.from_numpy(data.T)  # soundfile gives (time, channel)
        audio = {"waveform": waveform, "sample_rate": sample_rate}
        return [inference.crop(audio, Segment(start_s, end_s)).tolist() for start_s, end_s in spans]


class PyannoteSpeakerEmbedder:
    """`SpeakerEmbedder` Protocol implementation backed by pyannote/embedding."""

    def __init__(
        self, backend: EmbeddingModelBackend | None = None, hf_token: str | None = None
    ) -> None:
        token = hf_token if hf_token is not None else get_settings().huggingface_token
        self._backend = backend or _PyannoteEmbeddingBackend(hf_token=token)

    async def embed_speakers(
        self, audio_uri: str, turns: list[SpeakerTurn]
    ) -> dict[str, list[float]]:
        # Longest turn per cluster: a single clean stretch of one person
        # talking gives a better voiceprint than averaging across short
        # fragments, whose boundaries are exactly where diarization is least
        # reliable and most likely to include someone else's speech.
        longest: dict[str, SpeakerTurn] = {}
        for turn in turns:
            duration = turn.end_s - turn.start_s
            current = longest.get(turn.cluster_id)
            if current is None or duration > (current.end_s - current.start_s):
                longest[turn.cluster_id] = turn

        usable = {
            cluster_id: turn
            for cluster_id, turn in longest.items()
            if (turn.end_s - turn.start_s) >= MIN_CLUSTER_SECONDS
        }
        if not usable:
            return {}

        cluster_ids = list(usable)
        spans = [(usable[c].start_s, usable[c].end_s) for c in cluster_ids]
        vectors = self._backend.embed(audio_uri, spans)
        return {
            cluster_id: _l2_normalize(vector)
            for cluster_id, vector in zip(cluster_ids, vectors, strict=True)
        }
