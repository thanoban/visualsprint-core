"""Local-filesystem BlobStore for dev. Prod uses the S3/R2 implementation."""

from pathlib import Path

from app.config import get_settings

SCHEME = "blob://"


class LocalBlobStore:
    def __init__(self, root: str | None = None) -> None:
        self.root = Path(root or get_settings().blob_local_dir)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, uri: str) -> Path:
        if not uri.startswith(SCHEME):
            raise ValueError(f"not a blob uri: {uri}")
        rel = uri[len(SCHEME) :]
        p = (self.root / rel).resolve()
        if not p.is_relative_to(self.root.resolve()):
            raise ValueError("path escape rejected")
        return p

    async def put(
        self, key: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> str:
        uri = f"{SCHEME}{key}"
        p = self._path(uri)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return uri

    async def get(self, uri: str) -> bytes:
        return self._path(uri).read_bytes()

    async def exists(self, uri: str) -> bool:
        return self._path(uri).exists()

    async def delete(self, uri: str) -> None:
        self._path(uri).unlink(missing_ok=True)

    async def presigned_url(self, uri: str, expires_s: int = 3600) -> str:
        # Dev: served by the API's /blobs route; no signing.
        return f"/api/v1/blobs/{uri[len(SCHEME) :]}"
