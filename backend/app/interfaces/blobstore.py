"""BlobStore swap point — S3-compatible (Cloudflare R2) in prod, local dir in dev.

Stores FLAC audio (kept forever — re-transcribable as ASR improves; the corpus
is the moat) and keyframe images.
"""

from typing import Protocol


class BlobStore(Protocol):
    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        """Store bytes; returns a stable blob URI (e.g. 'blob://audio/<org>/<meeting>.flac')."""
        ...

    async def get(self, uri: str) -> bytes: ...

    async def exists(self, uri: str) -> bool: ...

    async def presigned_url(self, uri: str, expires_s: int = 3600) -> str:
        """Short-lived URL for UI evidence rendering (keyframe thumbnails, audio snippets)."""
        ...
