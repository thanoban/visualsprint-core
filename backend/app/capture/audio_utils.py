"""Shared audio conversion utilities for bot (Mode B) and companion (Mode C) capture."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import structlog

log = structlog.get_logger()


def webm_chunks_to_wav(chunks: list[bytes]) -> bytes | None:
    """Convert browser MediaRecorder WebM chunks to 16 kHz mono WAV.

    MediaRecorder emits independent WebM segments on each timeslice boundary.
    Naive byte-concatenation produces an invalid container (only the first
    chunk has a valid Matroska file header), which soundfile/libsndfile
    cannot read. The concat demuxer must receive every independent segment
    as a separate file; piping joined bytes was the production bug that left
    successful bot captures stuck retrying the transcribe stage.

    Returns None when conversion cannot be completed. The caller treats that
    as a capture failure instead of publishing an untranscribable artifact.
    """
    if shutil.which("ffmpeg") is None:
        return None
    try:
        with tempfile.TemporaryDirectory(prefix="visualsprint-audio-") as td:
            chunk_dir = Path(td)
            manifest = chunk_dir / "chunks.ffconcat"
            lines = ["ffconcat version 1.0"]
            for i, chunk in enumerate(chunks):
                if not chunk:
                    continue
                path = chunk_dir / f"chunk{i:06d}.webm"
                path.write_bytes(chunk)
                escaped_path = path.as_posix().replace("'", r"'\''")
                lines.append(f"file '{escaped_path}'")
            if len(lines) == 1:
                return None
            manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")
            result = subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-f", "concat",
                    "-safe", "0",
                    "-i", str(manifest),
                    "-ac", "1",
                    "-ar", "16000",
                    "-f", "wav",
                    "pipe:1",
                ],
                capture_output=True,
                timeout=300,
            )
        if result.returncode == 0 and result.stdout:
            return result.stdout
        log.warning(
            "audio_utils.webm_to_wav_failed",
            returncode=result.returncode,
            stderr=result.stderr.decode(errors="replace")[:400],
        )
    except Exception as exc:
        log.warning("audio_utils.webm_to_wav_failed", error=str(exc))
    return None
