"""BlobStore swap point — GCS in prod (VS_BLOB_BACKEND=gcs), local dir in dev.

Two-tier deletion model:

Tier 1 — automatic after pipeline (app/orchestrator/raw_cleanup.py):
    Raw audio (AudioTrack.uri WAV/FLAC) deleted after `transcribe` stage.
    Raw video (CaptureSession.video_uri) deleted after `screen` stage.
    Keyframe images are derived artifacts — they are KEPT permanently.

Tier 2 — opt-in per org (app/orchestrator/retention.py):
    Transcript text, keyframe images, and knowledge rationale are purged
    only when Org.retention_days is set (PDPA / compliance use cases).
"""

from collections.abc import AsyncIterator
from typing import Protocol


class BlobStore(Protocol):
    async def put(
        self, key: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> str:
        """Store bytes; returns a stable blob URI (e.g. 'blob://audio/<org>/<meeting>.flac')."""
        ...

    async def put_stream(
        self,
        key: str,
        stream: AsyncIterator[bytes],
        content_type: str = "application/octet-stream",
    ) -> str:
        """Stream bytes chunk-by-chunk; returns a stable blob URI.

        Avoids loading the full file into memory — required for uploads that
        may be several GiB (long recordings). Adapters that lack native
        streaming support may buffer internally, but the caller's memory is
        never burdened with the full payload.
        """
        ...

    async def get(self, uri: str) -> bytes: ...

    async def exists(self, uri: str) -> bool: ...

    async def delete(self, uri: str) -> None:
        """Idempotent: deleting an already-absent blob must not raise."""
        ...

    async def presigned_url(self, uri: str, expires_s: int = 3600) -> str:
        """Short-lived URL for UI evidence rendering (keyframe thumbnails, audio snippets)."""
        ...
