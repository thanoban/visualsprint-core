"""Silero VAD wrapper — segments raw audio into speech spans for the cascade.

Real inference lazy-loads Silero via torch.hub on first use only, so this
module (and unit tests that inject a fake backend) never requires network
access or even torch to be installed.
"""

from typing import Protocol

from app.asr.audio_io import TARGET_SAMPLE_RATE, read_audio

DEFAULT_THRESHOLD = 0.5
DEFAULT_MERGE_GAP_S = 0.15


class VadModelBackend(Protocol):
    def detect(self, samples, sample_rate: int, threshold: float) -> list[tuple[float, float]]:
        """Returns raw (start_s, end_s) speech spans, unmerged."""
        ...


class _SileroBackend:
    def __init__(self) -> None:
        self._model = None
        self._get_speech_timestamps = None

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        import torch

        model, utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad", model="silero_vad", trust_repo=True
        )
        self._model = model
        self._get_speech_timestamps = utils[0]

    def detect(self, samples, sample_rate: int, threshold: float) -> list[tuple[float, float]]:
        self._ensure_loaded()
        import torch

        tensor = torch.from_numpy(samples)
        timestamps = self._get_speech_timestamps(
            tensor, self._model, threshold=threshold, sampling_rate=sample_rate
        )
        return [(t["start"] / sample_rate, t["end"] / sample_rate) for t in timestamps]


class SileroVAD:
    def __init__(
        self,
        backend: VadModelBackend | None = None,
        threshold: float = DEFAULT_THRESHOLD,
        merge_gap_s: float = DEFAULT_MERGE_GAP_S,
    ) -> None:
        self._backend = backend or _SileroBackend()
        self._threshold = threshold
        self._merge_gap_s = merge_gap_s

    def detect_speech_spans(self, audio_path: str) -> list[tuple[float, float]]:
        samples, sample_rate = read_audio(audio_path)
        if sample_rate != TARGET_SAMPLE_RATE:
            samples, sample_rate = _resample(samples, sample_rate, TARGET_SAMPLE_RATE)
        if len(samples) == 0:
            return []
        raw_spans = self._backend.detect(samples, sample_rate, self._threshold)
        return _merge_close_spans(raw_spans, self._merge_gap_s)


def detect_speech_spans(audio_path: str, vad: SileroVAD | None = None) -> list[tuple[float, float]]:
    vad = vad or SileroVAD()
    return vad.detect_speech_spans(audio_path)


def _resample(samples, orig_sr: int, target_sr: int):
    if orig_sr == target_sr or len(samples) == 0:
        return samples, orig_sr
    import numpy as np

    duration = len(samples) / orig_sr
    target_len = max(1, int(round(duration * target_sr)))
    orig_idx = np.linspace(0, len(samples) - 1, num=len(samples))
    target_idx = np.linspace(0, len(samples) - 1, num=target_len)
    resampled = np.interp(target_idx, orig_idx, samples)
    return resampled.astype(np.float32), target_sr


def _merge_close_spans(spans: list[tuple[float, float]], gap_s: float) -> list[tuple[float, float]]:
    if not spans:
        return []
    ordered = sorted(spans, key=lambda s: s[0])
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        last_start, last_end = merged[-1]
        if start - last_end <= gap_s:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged
