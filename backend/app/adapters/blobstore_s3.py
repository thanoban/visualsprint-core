"""S3-compatible BlobStore — Cloudflare R2 via endpoint_url (zero egress fees).

Uses httpx + SigV4 via boto3 when the 'asr' extra pulls it in; kept minimal
here — boto3 is added when Mode A2 lands. For Phase 0 the local store is used.
"""

from app.config import get_settings

SCHEME = "blob://"


class S3BlobStore:
    """Placeholder wired for Phase 1 (Mode A2). Configuration is already in Settings:
    s3_endpoint_url / s3_bucket / s3_access_key_id / s3_secret_access_key."""

    def __init__(self) -> None:
        s = get_settings()
        if not s.s3_endpoint_url:
            raise RuntimeError("S3 blobstore selected but VS_S3_ENDPOINT_URL is not set")
        raise NotImplementedError(
            "S3/R2 backend lands with Mode A2 (Phase 1); use blob_backend=local"
        )


def get_blobstore():
    """Factory honouring settings.blob_backend."""
    from app.adapters.blobstore_local import LocalBlobStore

    s = get_settings()
    if s.blob_backend == "s3":
        return S3BlobStore()
    return LocalBlobStore()
