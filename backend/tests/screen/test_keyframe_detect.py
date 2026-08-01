import cv2
import numpy as np
import pytest

from app.screen.keyframe_detect import detect_keyframes

FPS = 10
SIZE = (64, 64)


# dHash encodes gradients between neighboring pixels, so a flat solid-color
# frame always hashes to zero regardless of color — real screen content always
# has texture (text, UI chrome), so test frames use a fixed-seed noise pattern
# per "screen" instead: identical bytes for every frame of one screen (hash
# distance 0 within a screen), meaningfully different bytes across screens.
def _pattern_frame(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(SIZE[1], SIZE[0], 3), dtype=np.uint8)


SCREEN_A = _pattern_frame(seed=1)
SCREEN_B = _pattern_frame(seed=2)
TRANSITION = _pattern_frame(seed=3)


def _write_video(path: str, frames: list[np.ndarray], fps: int = FPS) -> None:
    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, SIZE)
    for frame in frames:
        writer.write(frame)
    writer.release()


def _decode(image_bytes: bytes) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)


def _mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean())


@pytest.fixture
def two_screen_video(tmp_path) -> str:
    # 0-19 screen A (2.0s), 20-23 transition (0.4s, sampled once), 24-43 screen B (2.0s)
    frames = [SCREEN_A] * 20 + [TRANSITION] * 4 + [SCREEN_B] * 20
    path = str(tmp_path / "two_screen.mp4")
    _write_video(path, frames)
    return path


def test_detects_two_stable_keyframes_and_discards_transition(two_screen_video):
    candidates = detect_keyframes(two_screen_video, sample_fps=2.0, stable_frames=2)

    assert len(candidates) == 2
    first, second = candidates

    assert first.valid_from_s == pytest.approx(0.0, abs=1e-6)
    assert first.valid_to_s == pytest.approx(second.valid_from_s, abs=1e-6)
    assert second.valid_from_s == pytest.approx(2.5, abs=0.15)
    assert second.valid_to_s > second.valid_from_s

    # representative frames are closer to their own screen's pattern than to
    # the other screen's — the transient transition frame is never selected
    first_img = _decode(first.image_bytes)
    second_img = _decode(second.image_bytes)
    assert _mean_abs_diff(first_img, SCREEN_A) < _mean_abs_diff(first_img, SCREEN_B)
    assert _mean_abs_diff(second_img, SCREEN_B) < _mean_abs_diff(second_img, SCREEN_A)

    assert first.phash != second.phash


def test_no_keyframes_for_missing_video(tmp_path):
    assert detect_keyframes(str(tmp_path / "does_not_exist.mp4")) == []


def test_cursor_noise_does_not_fragment_a_single_stable_screen(tmp_path):
    rng = np.random.default_rng(0)
    frames = []
    for _ in range(20):
        frame = SCREEN_A.copy()
        # simulate a tiny cursor blip: a couple of pixels flipped each frame
        y, x = rng.integers(0, SIZE[1], size=2)
        frame[y, x] = (255, 255, 255)
        frames.append(frame)
    path = str(tmp_path / "cursor_noise.mp4")
    _write_video(path, frames)

    candidates = detect_keyframes(path, sample_fps=2.0, stable_frames=2)

    assert len(candidates) == 1
    assert candidates[0].valid_from_s == pytest.approx(0.0, abs=1e-6)


def test_stable_frames_requirement_discards_rapid_flicker(tmp_path):
    # alternating screen A/B every few sampled frames never forms a run >= stable_frames
    frames = []
    for i in range(20):
        frames.append(SCREEN_A if i % 5 < 3 else SCREEN_B)
    path = str(tmp_path / "flicker.mp4")
    _write_video(path, frames)

    candidates = detect_keyframes(path, sample_fps=10.0, stable_frames=5)

    assert candidates == []
