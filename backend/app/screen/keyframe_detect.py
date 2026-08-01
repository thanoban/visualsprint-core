"""Keyframe detection — sample a video, debounce noise, emit stable screen states.

Pipeline per sampled frame pair: dHash (imagehash) as a cheap first filter +
SSIM (skimage) as a confirming delta — both must agree a change is
"meaningful" before it counts, which is what keeps cursor blinks and
sub-pixel video-playback noise from spawning keyframes. A candidate
transition only becomes a keyframe once `stable_frames` consecutive samples
agree with each other (a "run"); shorter runs are mid-wipe/mid-animation
frames and are discarded outright rather than merged into a neighbor, since
they don't represent any screen state that was actually on screen long
enough to read.
"""

from __future__ import annotations

import cv2
import imagehash
import numpy as np
from PIL import Image
from pydantic import BaseModel
from skimage.metrics import structural_similarity as ssim

DEFAULT_SAMPLE_FPS = 1.5
DEFAULT_STABLE_FRAMES = 2
DEFAULT_HASH_DISTANCE_THRESHOLD = 10  # hamming distance over a 64-bit dHash
DEFAULT_SSIM_THRESHOLD = 0.92  # below this, frames are considered visually different
_SSIM_COMPARE_SIZE = (160, 90)  # downscale before SSIM — speed + robustness to tiny deltas
_JPEG_QUALITY = 85


class KeyframeCandidate(BaseModel):
    valid_from_s: float
    valid_to_s: float
    image_bytes: bytes
    phash: str


class _SampledFrame:
    __slots__ = ("ts_s", "frame", "phash")

    def __init__(self, ts_s: float, frame: np.ndarray) -> None:
        self.ts_s = ts_s
        self.frame = frame
        self.phash = imagehash.dhash(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))


def detect_keyframes(
    video_path: str,
    sample_fps: float = DEFAULT_SAMPLE_FPS,
    stable_frames: int = DEFAULT_STABLE_FRAMES,
    hash_distance_threshold: int = DEFAULT_HASH_DISTANCE_THRESHOLD,
    ssim_threshold: float = DEFAULT_SSIM_THRESHOLD,
) -> list[KeyframeCandidate]:
    frames = _sample_frames(video_path, sample_fps)
    if not frames:
        return []

    runs = _group_stable_runs(frames, hash_distance_threshold, ssim_threshold)
    confirmed = [run for run in runs if len(run) >= max(1, stable_frames)]
    if not confirmed:
        return []

    frame_interval_s = 1.0 / sample_fps if sample_fps > 0 else 0.0
    video_end_s = frames[-1].ts_s + frame_interval_s

    candidates: list[KeyframeCandidate] = []
    for i, run in enumerate(confirmed):
        valid_from_s = run[0].ts_s
        valid_to_s = confirmed[i + 1][0].ts_s if i + 1 < len(confirmed) else video_end_s
        representative = run[0]
        candidates.append(
            KeyframeCandidate(
                valid_from_s=valid_from_s,
                valid_to_s=valid_to_s,
                image_bytes=_encode_jpeg(representative.frame),
                phash=str(representative.phash),
            )
        )
    return candidates


def _sample_frames(video_path: str, sample_fps: float) -> list[_SampledFrame]:
    cap = cv2.VideoCapture(video_path)
    try:
        if not cap.isOpened():
            return []
        source_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        frame_interval = max(1, round(source_fps / sample_fps)) if sample_fps > 0 else 1

        sampled: list[_SampledFrame] = []
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % frame_interval == 0:
                sampled.append(_SampledFrame(idx / source_fps, frame))
            idx += 1
        return sampled
    finally:
        cap.release()


def _group_stable_runs(
    frames: list[_SampledFrame], hash_distance_threshold: int, ssim_threshold: float
) -> list[list[_SampledFrame]]:
    runs: list[list[_SampledFrame]] = [[frames[0]]]
    for prev, current in zip(frames, frames[1:], strict=False):
        if _is_significant_change(prev, current, hash_distance_threshold, ssim_threshold):
            runs.append([current])
        else:
            runs[-1].append(current)
    return runs


def _is_significant_change(
    a: _SampledFrame, b: _SampledFrame, hash_distance_threshold: int, ssim_threshold: float
) -> bool:
    hash_distance = a.phash - b.phash
    if hash_distance < hash_distance_threshold:
        return False
    return _ssim_score(a.frame, b.frame) <= ssim_threshold


def _ssim_score(frame_a: np.ndarray, frame_b: np.ndarray) -> float:
    gray_a = cv2.resize(cv2.cvtColor(frame_a, cv2.COLOR_BGR2GRAY), _SSIM_COMPARE_SIZE)
    gray_b = cv2.resize(cv2.cvtColor(frame_b, cv2.COLOR_BGR2GRAY), _SSIM_COMPARE_SIZE)
    return float(ssim(gray_a, gray_b))


def _encode_jpeg(frame: np.ndarray) -> bytes:
    ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, _JPEG_QUALITY])
    if not ok:
        raise RuntimeError("failed to encode keyframe as JPEG")
    return buffer.tobytes()
