"""Local audio I/O shared by VAD, LID, and the cascade's vendor slicing.

Everything here reads 16 kHz mono FLAC/WAV already materialized on local
disk (the cascade pulls the blob down before calling into this module) —
no vendor or blob-store concerns belong here.
"""

import io

import numpy as np
import soundfile as sf

TARGET_SAMPLE_RATE = 16_000


def read_audio(audio_path: str) -> tuple[np.ndarray, int]:
    data, sample_rate = sf.read(audio_path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1).astype(np.float32)
    return data, sample_rate


def duration_s(audio_path: str) -> float:
    info = sf.info(audio_path)
    return info.frames / info.samplerate


def slice_window(audio_path: str, start_s: float, end_s: float) -> tuple[np.ndarray, int]:
    samples, sample_rate = read_audio(audio_path)
    start_idx = max(0, int(start_s * sample_rate))
    end_idx = min(len(samples), int(end_s * sample_rate))
    if end_idx <= start_idx:
        return np.zeros(0, dtype=np.float32), sample_rate
    return samples[start_idx:end_idx], sample_rate


def slice_to_wav_bytes(audio_path: str, start_s: float, end_s: float) -> bytes:
    samples, sample_rate = slice_window(audio_path, start_s, end_s)
    buffer = io.BytesIO()
    sf.write(buffer, samples, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()
