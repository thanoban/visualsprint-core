"""S3-compatible BlobStore — Cloudflare R2 in prod (zero egress fees).

Uses `botocore` for SigV4 request signing only, not the full `boto3` SDK —
lighter dependency footprint, same battle-tested signing code. botocore's
client is synchronous, so every network call is wrapped in
`asyncio.to_thread` to avoid blocking the event loop; `presigned_url` is
pure local computation (no network call) and runs inline.

Lazy-loaded client, injectable via constructor — same pattern as every other
vendor-backed adapter in this codebase (PaddleOCR, pyannote, VoxLingua107):
tests inject a fake client and never trigger the real botocore import, so
this file is fully testable without botocore installed.
"""

import asyncio
from typing import Any, Protocol

from app.config import get_settings

SCHEME = "blob://"


class S3ClientBackend(Protocol):
    """Subset of botocore's S3 client this adapter actually uses."""

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> Any: ...
    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]: ...
    def head_object(self, *, Bucket: str, Key: str) -> Any: ...
    def generate_presigned_url(
        self, operation: str, Params: dict[str, str], ExpiresIn: int
    ) -> str: ...


def _build_botocore_client(
    endpoint_url: str, access_key_id: str | None, secret_access_key: str | None
) -> S3ClientBackend:
    import botocore.session

    session = botocore.session.get_session()
    return session.create_client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        # R2 (and most S3-compatible stores) don't use AWS regions; botocore
        # requires *some* value, "auto" is R2's own documented convention.
        region_name="auto",
    )


class S3BlobStore:
    """`BlobStore` Protocol implementation over any S3-compatible endpoint."""

    def __init__(self, client: S3ClientBackend | None = None, bucket: str | None = None) -> None:
        settings = get_settings()
        if client is None and not settings.s3_endpoint_url:
            raise RuntimeError("S3 blobstore selected but VS_S3_ENDPOINT_URL is not set")
        self._bucket = bucket or settings.s3_bucket
        self._client = client
        self._endpoint_url = settings.s3_endpoint_url
        self._access_key_id = settings.s3_access_key_id
        self._secret_access_key = settings.s3_secret_access_key

    def _ensure_client(self) -> S3ClientBackend:
        if self._client is None:
            self._client = _build_botocore_client(
                self._endpoint_url, self._access_key_id, self._secret_access_key
            )
        return self._client

    def _key_from_uri(self, uri: str) -> str:
        if not uri.startswith(SCHEME):
            raise ValueError(f"not a blob uri: {uri}")
        return uri[len(SCHEME) :]

    async def put(
        self, key: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> str:
        client = self._ensure_client()
        await asyncio.to_thread(
            client.put_object, Bucket=self._bucket, Key=key, Body=data, ContentType=content_type
        )
        return f"{SCHEME}{key}"

    async def get(self, uri: str) -> bytes:
        client = self._ensure_client()
        key = self._key_from_uri(uri)
        response = await asyncio.to_thread(client.get_object, Bucket=self._bucket, Key=key)
        body = response["Body"]
        # botocore's StreamingBody.read() is itself blocking I/O.
        return await asyncio.to_thread(body.read)

    async def exists(self, uri: str) -> bool:
        client = self._ensure_client()
        key = self._key_from_uri(uri)
        try:
            await asyncio.to_thread(client.head_object, Bucket=self._bucket, Key=key)
            return True
        except Exception as exc:
            # botocore raises ClientError with a response["Error"]["Code"]
            # for a real "not found"; anything else (auth failure, network
            # error, bucket doesn't exist) must not be swallowed as "False" —
            # that would silently misreport a real outage as a missing blob.
            error_code = getattr(exc, "response", {}).get("Error", {}).get("Code")
            if error_code in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    async def presigned_url(self, uri: str, expires_s: int = 3600) -> str:
        client = self._ensure_client()
        key = self._key_from_uri(uri)
        return client.generate_presigned_url(
            "get_object", Params={"Bucket": self._bucket, "Key": key}, ExpiresIn=expires_s
        )


def get_blobstore():
    """Factory honouring settings.blob_backend."""
    from app.adapters.blobstore_local import LocalBlobStore

    s = get_settings()
    if s.blob_backend == "s3":
        return S3BlobStore()
    return LocalBlobStore()
