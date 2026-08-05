"""Unit coverage for app.asr.audio_io -- the local WAV/FLAC slicing shared by
VAD, LID, and the cascade's per-segment vendor calls. Pure numpy/soundfile,
no vendor or blob-store concerns, so nothing here needs fakes or network."""

import numpy as np
import pytest
import soundfile as sf

from app.asr.audio_io import (
    TARGET_SAMPLE_RATE,
    duration_s,
    read_audio,
    slice_to_wav_bytes,
    slice_window,
)


def _write_wav(path, samples: np.ndarray, sample_rate: int = TARGET_SAMPLE_RATE) -> str:
    sf.write(str(path), samples, sample_rate, subtype="PCM_16")
    return str(path)


def test_read_audio_returns_samples_and_sample_rate(tmp_path):
    samples = np.linspace(-0.5, 0.5, TARGET_SAMPLE_RATE, dtype=np.float32)
    path = _write_wav(tmp_path / "mono.wav", samples)

    data, sample_rate = read_audio(path)

    assert sample_rate == TARGET_SAMPLE_RATE
    assert data.shape[0] == TARGET_SAMPLE_RATE
    assert data.dtype == np.float32


def test_read_audio_downmixes_stereo_to_mono(tmp_path):
    left = np.full(1000, 0.2, dtype=np.float32)
    right = np.full(1000, -0.2, dtype=np.float32)
    stereo = np.stack([left, right], axis=1)
    path = _write_wav(tmp_path / "stereo.wav", stereo)

    data, _ = read_audio(path)

    assert data.ndim == 1
    assert data.shape[0] == 1000
    assert np.allclose(data, 0.0, atol=1e-3)


def test_duration_s_matches_sample_count(tmp_path):
    samples = np.zeros(TARGET_SAMPLE_RATE * 3, dtype=np.float32)
    path = _write_wav(tmp_path / "three_seconds.wav", samples)

    assert duration_s(path) == 3.0


def test_slice_window_returns_the_requested_span(tmp_path):
    # PCM_16 clips to [-1, 1], so the ramp must stay in range or the
    # written/read-back samples won't match what was asked for.
    samples = np.linspace(-1.0, 1.0, TARGET_SAMPLE_RATE * 2, dtype=np.float32)
    path = _write_wav(tmp_path / "ramp.wav", samples)

    sliced, sample_rate = slice_window(path, 1.0, 1.5)

    assert sample_rate == TARGET_SAMPLE_RATE
    assert sliced.shape[0] == TARGET_SAMPLE_RATE // 2
    assert sliced[0] == pytest.approx(samples[TARGET_SAMPLE_RATE], abs=1e-4)


def test_slice_window_clamps_to_audio_bounds(tmp_path):
    samples = np.zeros(TARGET_SAMPLE_RATE, dtype=np.float32)
    path = _write_wav(tmp_path / "one_second.wav", samples)

    sliced, _ = slice_window(path, -5.0, 999.0)

    assert sliced.shape[0] == TARGET_SAMPLE_RATE


def test_slice_window_returns_empty_for_a_backwards_or_empty_range(tmp_path):
    samples = np.zeros(TARGET_SAMPLE_RATE, dtype=np.float32)
    path = _write_wav(tmp_path / "one_second.wav", samples)

    sliced, sample_rate = slice_window(path, 0.8, 0.2)

    assert sliced.shape[0] == 0
    assert sample_rate == TARGET_SAMPLE_RATE


def test_slice_to_wav_bytes_round_trips_through_soundfile(tmp_path):
    samples = np.linspace(-1.0, 1.0, TARGET_SAMPLE_RATE, dtype=np.float32)
    path = _write_wav(tmp_path / "sweep.wav", samples)

    wav_bytes = slice_to_wav_bytes(path, 0.0, 1.0)

    assert wav_bytes[:4] == b"RIFF"
    assert wav_bytes[8:12] == b"WAVE"


def test_slice_to_wav_bytes_on_an_empty_slice_is_still_a_valid_wav_header(tmp_path):
    samples = np.zeros(TARGET_SAMPLE_RATE, dtype=np.float32)
    path = _write_wav(tmp_path / "one_second.wav", samples)

    wav_bytes = slice_to_wav_bytes(path, 5.0, 6.0)

    assert wav_bytes[:4] == b"RIFF"
