"""Shared helper: download a remote recording URL and land it in BlobStore as FLAC.

Store all audio as FLAC forever (docs/03-capture.md) — every meeting stays
re-transcribable as ASR improves. Transcode happens by shelling out to ffmpeg; if
ffmpeg isn't on PATH in this environment, the source bytes are stored as-is under
their original extension so the pipeline doesn't stall, with a TODO marker for a
backfill transcode job. Downstream code must not assume every blob is already FLAC —
that's tracked by the returned URI's extension.
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from app.interfaces.blobstore import BlobStore

FLAC_CONTENT_TYPE = "audio/flac"
FALLBACK_CONTENT_TYPE = "application/octet-stream"


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def _transcode_to_flac(src_bytes: bytes, src_suffix: str) -> bytes | None:
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

    flac_bytes = _transcode_to_flac(raw, source_suffix)
    if flac_bytes is not None:
        return await blob_store.put(f"{blob_key}.flac", flac_bytes, content_type=FLAC_CONTENT_TYPE)

    # TODO(ffmpeg-unavailable): store source bytes untranscoded; a backfill job must
    # convert these to FLAC once ffmpeg is provisioned in the runtime environment.
    return await blob_store.put(
        f"{blob_key}{source_suffix}", raw, content_type=FALLBACK_CONTENT_TYPE
    )
