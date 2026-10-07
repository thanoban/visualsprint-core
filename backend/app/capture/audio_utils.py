"""Shared audio conversion utilities for bot (Mode B) and companion (Mode C) capture."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import structlog

log = structlog.get_logger()

_EBML_HEADER = b"\x1a\x45\xdf\xa3"


def transcode_webm_file(source: Path, output: Path) -> None:
    """Disk-to-disk conversion without buffering a multi-hour WAV in RAM."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg is required to process captured audio")
    result = subprocess.run(
        [ffmpeg, "-v", "error", "-y", "-i", str(source),
         "-ac", "1", "-ar", "16000", str(output)],
        capture_output=True, timeout=300,
    )
    if result.returncode or not output.exists() or output.stat().st_size == 0:
        raise RuntimeError(f"audio transcode failed: {result.stderr.decode(errors='replace')[:400]}")


def webm_chunks_to_wav(chunks: list[bytes]) -> bytes | None:
    """Convert browser MediaRecorder WebM chunks to 16 kHz mono WAV.

    A single MediaRecorder start/stop emits ONE container split across blobs.
    Timeslice blobs are not independently playable WebM files. Reassemble them
    in order; use the concat demuxer only when EVERY blob begins with an EBML
    header, indicating independent recordings (e.g. recorder restarts).

    Returns None when conversion cannot be completed. The caller treats that
    as a capture failure instead of publishing an untranscribable artifact.
    """
    chunks = [chunk for chunk in chunks if chunk]
    ffmpeg = shutil.which("ffmpeg")
    if not chunks or ffmpeg is None:
        return None
    try:
        with tempfile.TemporaryDirectory(prefix="visualsprint-audio-") as td:
            chunk_dir = Path(td)
            if len(chunks) > 1 and all(c.startswith(_EBML_HEADER) for c in chunks):
                manifest = chunk_dir / "chunks.ffconcat"
                lines = ["ffconcat version 1.0"]
                for i, chunk in enumerate(chunks):
                    path = chunk_dir / f"chunk{i:06d}.webm"
                    path.write_bytes(chunk)
                    escaped_path = path.as_posix().replace("'", r"'\''")
                    lines.append(f"file '{escaped_path}'")
                manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")
                inputs = ["-f", "concat", "-safe", "0", "-i", str(manifest)]
            else:
                source = chunk_dir / "recording.webm"
                with source.open("wb") as stream:
                    for chunk in chunks:
                        stream.write(chunk)
                inputs = ["-i", str(source)]
            result = subprocess.run(
                [
                    ffmpeg, "-y",
                    *inputs,
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
