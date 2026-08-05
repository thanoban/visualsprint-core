"""Shared helper: download a remote recording URL and land it in BlobStore as FLAC.

Store all audio as FLAC forever (docs/03-capture.md) — every meeting stays
re-transcribable as ASR improves. Transcode happens by shelling out to ffmpeg; if
ffmpeg isn't on PATH in this environment, the source bytes are stored as-is under
their original extension so the pipeline doesn't stall — app/orchestrator/
transcode_backfill.py's periodic sweep retries these once ffmpeg is provisioned.
Downstream code must not assume every blob is already FLAC — that's tracked by
the returned URI's extension.
"""

import shutil
import subprocess
import tempfile
import wave
from io import BytesIO
from pathlib import Path

import httpx

from app.interfaces.blobstore import BlobStore

FLAC_CONTENT_TYPE = "audio/flac"
FALLBACK_CONTENT_TYPE = "application/octet-stream"


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def transcode_to_flac(src_bytes: bytes, src_suffix: str) -> bytes | None:
    """Returns FLAC bytes, or None if ffmpeg is unavailable — caller decides fallback."""
    if not _ffmpeg_available():
        return None
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / f"in{src_suffix}"
        dst = Path(td) / "out.flac"
        src.write_bytes(src_bytes)
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", str(dst)],
            check=True,
            capture_output=True,
        )
        return dst.read_bytes()


def _pcm_to_wav(pcm_bytes: bytes, *, sample_rate: int, channels: int) -> bytes:
    """Wraps raw L16 PCM (RTMS's on-the-wire audio format) in a WAV header —
    pure stdlib, no ffmpeg needed for this step, so it always succeeds."""
    buf = BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)  # L16 = 16-bit signed PCM
        wav.setframerate(sample_rate)
        wav.writeframes(pcm_bytes)
    return buf.getvalue()


async def pcm_to_flac_blob(
    pcm_bytes: bytes,
    blob_store: BlobStore,
    blob_key: str,
    *,
    sample_rate: int = 8000,
    channels: int = 1,
) -> str:
    """RTMS delivers raw PCM frames, not a downloadable file — this is the
    equivalent of `download_and_store` for that path. `blob_key` must NOT
    include an extension. Same ffmpeg-unavailable fallback convention as
    `download_and_store`: store the WAV untranscoded rather than stall the
    pipeline; app/orchestrator/transcode_backfill.py retries it later."""
    wav_bytes = _pcm_to_wav(pcm_bytes, sample_rate=sample_rate, channels=channels)

    flac_bytes = transcode_to_flac(wav_bytes, ".wav")
    if flac_bytes is not None:
        return await blob_store.put(f"{blob_key}.flac", flac_bytes, content_type=FLAC_CONTENT_TYPE)

    return await blob_store.put(f"{blob_key}.wav", wav_bytes, content_type="audio/wav")


async def download_and_store(
    *,
    source_url: str,
    blob_store: BlobStore,
    blob_key: str,
    http_client: httpx.AsyncClient,
    source_suffix: str = ".m4a",
    extra_headers: dict[str, str] | None = None,
) -> str:
    """Download `source_url`, transcode to FLAC if ffmpeg is available, store via
    BlobStore. `blob_key` must NOT include an extension — one is appended depending on
    whether transcoding succeeded. Returns the resulting blob URI.
    """
    resp = await http_client.get(source_url, headers=extra_headers, follow_redirects=True)
    resp.raise_for_status()
    raw = resp.content

    flac_bytes = transcode_to_flac(raw, source_suffix)
    if flac_bytes is not None:
        return await blob_store.put(f"{blob_key}.flac", flac_bytes, content_type=FLAC_CONTENT_TYPE)

    # ffmpeg unavailable -- store untranscoded rather than stall the pipeline;
    # app/orchestrator/transcode_backfill.py retries this once ffmpeg is provisioned.
    return await blob_store.put(
        f"{blob_key}{source_suffix}", raw, content_type=FALLBACK_CONTENT_TYPE
    )
