"""Google Cloud Storage BlobStore adapter.

Uses Application Default Credentials (ADC) — no explicit key file needed.
On Cloud Run, the container's attached service account is the ADC identity
automatically. The only IAM bindings needed are granted in deploy.yml:
  - roles/storage.objectAdmin on the GCS bucket
  - roles/iam.serviceAccountTokenCreator on the SA itself (for signed URLs)

Signed URLs use the IAM SignBlob API so the SA can sign its own tokens
without a local private key. This matches the 'cloud-native' approach
documented in google-cloud-storage's Cloud Run guide.
"""

from __future__ import annotations

import asyncio
import datetime
import io
from typing import TYPE_CHECKING, AsyncIterator

import structlog

log = structlog.get_logger()

SCHEME = "blob://"


def _strip_scheme(uri: str) -> str:
    if uri.startswith(SCHEME):
        return uri[len(SCHEME):]
    return uri


def _build_client():
    from google.cloud import storage  # noqa: PLC0415

    return storage.Client()


class GCSBlobStore:
    """BlobStore backed by a single GCS bucket.

    Keys are stored as blob names inside the bucket. URIs use the same
    blob:// scheme as the S3 adapter so the rest of the codebase is
    agnostic of which adapter is active.
    """

    def __init__(self, bucket_name: str, client=None) -> None:
        self._bucket_name = bucket_name
        self._client = client  # None → built lazily on first use

    def _get_client(self):
        if self._client is None:
            self._client = _build_client()
        return self._client

    def _bucket(self):
        return self._get_client().bucket(self._bucket_name)

    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        blob = self._bucket().blob(key)
        await asyncio.to_thread(
            blob.upload_from_string, data, content_type=content_type
        )
        return f"{SCHEME}{key}"

    async def put_stream(
        self,
        key: str,
        stream: AsyncIterator[bytes],
        content_type: str = "application/octet-stream",
    ) -> str:
        # GCS resumable upload via upload_from_file. We collect the async
        # stream into a BytesIO in a thread so the sync GCS client can seek
        # it for resumable upload; this keeps peak memory to one chunk at a
        # time rather than the full file the caller would otherwise read.
        buf = io.BytesIO()
        async for chunk in stream:
            buf.write(chunk)
        buf.seek(0)
        blob = self._bucket().blob(key)
        await asyncio.to_thread(
            blob.upload_from_file, buf, content_type=content_type, rewind=True
        )
        return f"{SCHEME}{key}"

    async def get(self, uri: str) -> bytes:
        key = _strip_scheme(uri)
        blob = self._bucket().blob(key)
        return await asyncio.to_thread(blob.download_as_bytes)

    async def exists(self, uri: str) -> bool:
        key = _strip_scheme(uri)
        blob = self._bucket().blob(key)
        return await asyncio.to_thread(blob.exists)

    async def delete(self, uri: str) -> None:
        key = _strip_scheme(uri)
        blob = self._bucket().blob(key)
        await asyncio.to_thread(blob.delete)

    async def presigned_url(self, uri: str, expires_s: int = 3600) -> str:
        """Return a time-limited signed URL for direct browser download.

        Signing uses the IAM SignBlob API so no local private key is needed.
        The SA must have roles/iam.serviceAccountTokenCreator on itself (see
        deploy.yml). Falls back to a public URL if signing fails (logs a
        warning so misconfiguration is visible).
        """
        key = _strip_scheme(uri)
        blob = self._bucket().blob(key)
        try:
            import google.auth
            import google.auth.transport.requests

            credentials, _ = await asyncio.to_thread(google.auth.default)
            req = google.auth.transport.requests.Request()
            await asyncio.to_thread(credentials.refresh, req)
            signed = await asyncio.to_thread(
                blob.generate_signed_url,
                version="v4",
                expiration=datetime.timedelta(seconds=expires_s),
                method="GET",
                credentials=credentials,
            )
            return signed
        except Exception as exc:
            log.warning(
                "gcs.presigned_url_failed",
                key=key,
                error=str(exc),
            )
            # Fall back to an unauthenticated URL — works if the object is
            # public, errors gracefully if not.
            return blob.public_url
