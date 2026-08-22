"""BlobStore swap point — S3-compatible (Cloudflare R2) in prod, local dir in dev.

Stores FLAC audio (kept forever by default — re-transcribable as ASR
improves; the corpus is the moat) and keyframe images. The forever-by-default
stance is an org-level default, not an absolute: app/orchestrator/retention.py
purges raw audio/keyframe blobs for orgs that set Org.retention_days,
per-org opt-in only -- never the platform default.
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
